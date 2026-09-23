import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerMessageDecoder } from "./client-message-decoder.js";
import { createClientHarness } from "./test-support.js";

const harnesses: Array<ReturnType<typeof createClientHarness>> = [];

function createHarness() {
  const harness = createClientHarness({ autoEmitExit: false });
  harnesses.push(harness);
  return harness;
}

function requestId(harness: ReturnType<typeof createClientHarness>, index = 0): number | string {
  const request = JSON.parse(harness.writes[index] ?? "{}") as {
    id: number | string;
    method: string;
  };
  expect(request.method).toBe("thread/list");
  return request.id;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.client.close();
    harness.emitExit();
    await harness.client.closeAndWait();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex catalog preview decoding", () => {
  it.each([0, 1])(
    "projects only the remaining %i catalog rows without shrinking the native page",
    async (catalogRows) => {
      const harness = createHarness();
      const selectedPreview = "\u001b[32mKept first user request\u001b[0m";
      const cache = vi.fn((thread: { id: string }) => {
        if (catalogRows === 0 || thread.id !== "selected") {
          throw new Error("Discarded rows must not read the resident preview cache");
        }
        return undefined;
      });
      const request = harness.client.request(
        "thread/list",
        { limit: 64, cursor: "native-start", useStateDbOnly: true },
        { timeoutMs: 1_000, catalogPreview: true, catalogPreviewCache: cache, catalogRows },
      );
      const frame = JSON.parse(harness.writes[0]!);
      expect(frame).toMatchObject({
        method: "thread/list",
        params: { limit: 64, cursor: "native-start", useStateDbOnly: true },
      });
      expect(frame.params).not.toHaveProperty("catalogRows");
      harness.send({
        id: requestId(harness),
        result: {
          data: Array.from({ length: 64 }, (_, index) =>
            index === 0
              ? {
                  id: "selected",
                  projectId: null,
                  preview: selectedPreview,
                  cwd: "/workspace/selected",
                }
              : {
                  id: `discarded-${index}`,
                  preview: "Discarded preview ".repeat(1024),
                  path: "/".repeat(4097),
                  turns: [{ items: [{ text: "Discarded transcript ".repeat(1024) }] }],
                },
          ),
          nextCursor: "opaque-native-next",
          backwardsCursor: "opaque-native-previous",
        },
      });
      await expect(request).resolves.toEqual({
        data: catalogRows
          ? [
              {
                id: "selected",
                projectId: null,
                preview: "Kept first user request",
                cwd: "/workspace/selected",
              },
            ]
          : [],
        nextCursor: "opaque-native-next",
        backwardsCursor: "opaque-native-previous",
      });
      expect(cache.mock.calls.map(([thread]) => thread.id)).toEqual(
        catalogRows ? ["selected"] : [],
      );
      expect(harness.writes).toHaveLength(1);
    },
  );

  it("bounds catalog previews before delivery while preserving ordinary thread/list results", async () => {
    const parse = vi.spyOn(CodexAppServerMessageDecoder.prototype, "parse");
    const harness = createHarness();
    const preview = "x".repeat(1024 * 1024);
    type PreviewPage = { data: Array<{ id: string; preview: string }> };
    const catalog = harness.client.request<PreviewPage>(
      "thread/list",
      { limit: 1 },
      { timeoutMs: 1_000, catalogPreview: true },
    );
    const first = JSON.parse(harness.writes[0]!);
    harness.send({ id: first.id, result: { data: [{ id: "large-preview", preview }] } });
    expect((await catalog).data[0]?.preview).toBe("x".repeat(500));
    expect(parse).not.toHaveBeenCalled();

    const ordinary = harness.client.request<PreviewPage>(
      "thread/list",
      { limit: 1 },
      { timeoutMs: 1_000 },
    );
    const second = JSON.parse(harness.writes[1]!);
    harness.send({ id: second.id, result: { data: [{ id: "large-preview", preview }] } });
    expect((await ordinary).data[0]?.preview).toBe(preview);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("reuses unchanged resident previews after worker projection", async () => {
    const harness = createHarness();
    const catalogPreviewCache = (thread: { updatedAt?: number | null }) =>
      thread.updatedAt === 100 ? "Retained first user request" : undefined;
    for (const updatedAt of [100, 101]) {
      const request = harness.client.request<{ data: Array<{ preview: string }> }>(
        "thread/list",
        { limit: 64, useStateDbOnly: true },
        { catalogPreview: true, catalogPreviewCache },
      );
      harness.send({
        id: requestId(harness, updatedAt - 100),
        result: {
          data: [
            {
              id: "cached-preview",
              updatedAt,
              preview: "new ".repeat(100_000),
            },
          ],
        },
      });
      const page = await request;
      if (updatedAt === 100) {
        expect(page.data[0]?.preview).toBe("Retained first user request");
      } else {
        expect(page.data[0]?.preview).toBe("new ".repeat(125));
      }
    }
  });

  it("discards unused native payloads before retaining a catalog response", async () => {
    const harness = createHarness();
    const large = "unused native history ".repeat(100_000);
    const thread = {
      id: "bounded-metadata",
      preview: "Please review the sidebar and check its session ordering.",
      cwd: "/workspace/project",
      name: "Sidebar review",
      gitInfo: { branch: "catalog-fix", sha: large, originUrl: large },
      extra: { payload: large },
      turns: [{ items: [{ text: large }] }],
    };
    const catalog = harness.client.request<{ data: Array<typeof thread> }>(
      "thread/list",
      { limit: 64, useStateDbOnly: true },
      { timeoutMs: 1_000, catalogPreview: true },
    );
    harness.send({ id: requestId(harness), result: { data: [thread] } });
    const page = await catalog;
    expect(page.data[0]).toMatchObject({
      id: thread.id,
      preview: thread.preview,
      cwd: thread.cwd,
      name: thread.name,
      gitInfo: { branch: "catalog-fix" },
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2_048);
    const ordinary = harness.client.request("thread/list", { limit: 64, useStateDbOnly: true });
    harness.send({ id: requestId(harness, 1), result: { data: [thread] } });
    await expect(ordinary).resolves.toEqual({ data: [thread] });
  });

  it.each([0, 64 * 1024])(
    "preserves native preview cache states with %i bytes of padding",
    async (padding) => {
      const harness = createHarness();
      const cases = [
        { id: "cleared", preview: "", cached: "retained", expected: "" },
        { id: "whitespace", preview: " \n\t ", cached: "retained", expected: "retained" },
        { id: "controls", preview: "\u001b[0m", cached: "retained", expected: "retained" },
        { id: "newly-visible", preview: "visible", cached: "", expected: "visible" },
        { id: "missing", cached: "retained", expected: "retained" },
        { id: "missing-empty", cached: "", expected: "" },
        { id: "empty", preview: "", cached: "", expected: "" },
        { id: "cache-miss", preview: "uncached", cached: undefined, expected: "uncached" },
      ];
      const previews = new Map(cases.map(({ id, cached }) => [id, cached]));
      const cache = vi.fn(({ id }: { id: string }) => previews.get(id));
      const request = harness.client.request(
        "thread/list",
        { limit: 64 },
        { catalogPreview: true, catalogPreviewCache: cache },
      );
      harness.send({
        id: requestId(harness),
        result: {
          data: cases.map(({ id, preview }) => ({ id, preview })),
          unused: "x".repeat(padding),
        },
      });
      await expect(request).resolves.toEqual({
        data: cases.map(({ id, expected }) => ({ id, projectId: null, preview: expected })),
      });
      expect(cache.mock.calls.map(([thread]) => thread.id)).toEqual(cases.map(({ id }) => id));
    },
  );

  it.each([
    {
      name: "leading whitespace beyond the input prefix",
      preview: " \t\n".repeat(4096) + "visible",
      expected: "visible",
    },
    {
      name: "whitespace before ANSI removal",
      preview: "a \u001b[0m b",
      expected: "a  b",
    },
    {
      name: "space at the output boundary",
      preview: "x".repeat(499) + " " + "y".repeat(4096),
      expected: "x".repeat(499) + " ",
    },
    {
      name: "trailing whitespace beyond the input prefix",
      preview: "x".repeat(499) + " \n\t".repeat(4096),
      expected: "x".repeat(499),
    },
    {
      name: "surrogate pair across the output boundary",
      preview: "x".repeat(499) + "😀" + "y".repeat(4096),
      expected: "x".repeat(499),
    },
    {
      name: "surrogate pair fitting the output boundary",
      preview: "x".repeat(498) + "😀" + "y".repeat(4096),
      expected: "x".repeat(498) + "😀",
    },
    {
      name: "surrogate pair across the input prefix",
      preview: "x".repeat(2047) + "😀tail",
      expected: "x".repeat(500),
    },
    {
      name: "surrogate lookahead after whitespace normalization",
      preview: " ".repeat(1548) + "x".repeat(499) + "😀tail",
      expected: "x".repeat(499),
    },
    {
      name: "lone surrogate in a short preview",
      preview: "\ud800 visible",
      expected: "\ufffd visible",
    },
    {
      name: "lone surrogate at the output boundary",
      preview: "x".repeat(499) + "\ud800" + "y".repeat(4096),
      expected: "x".repeat(499) + "\ufffd",
    },
    {
      name: "C0 removal after whitespace normalization",
      preview: "a\u0000b \u007f c".repeat(400),
      expected: "ab  c".repeat(100),
    },
    {
      name: "OSC terminator beyond the input prefix",
      preview: "\u001b]0;" + "p".repeat(3000) + "\u0007visible",
      expected: "visible",
    },
    {
      name: "unterminated OSC payload",
      preview: "\u001b]0;" + "p".repeat(3000),
      expected: "]0;" + "p".repeat(497),
    },
    {
      name: "C1 CSI crossing the input prefix",
      preview: "\u009b" + "1;".repeat(1500) + "31mvisible",
      expected: "visible",
    },
    {
      name: "C1 OSC crossing the input prefix",
      preview: "\u009d" + "p".repeat(3000) + "\u009cvisible",
      expected: "visible",
    },
    {
      name: "escape introducer at the input boundary",
      preview: "x".repeat(2047) + "\u001b[31mTAIL",
      expected: "x".repeat(500),
    },
    {
      name: "controls only after the certified prefix",
      preview: "x".repeat(2048) + "\u001b]0;" + "p".repeat(4096),
      expected: "x".repeat(500),
    },
    {
      name: "C1 next-line is not JavaScript whitespace",
      preview: "a\u0085b" + "x".repeat(4096),
      expected: "ab" + "x".repeat(498),
    },
    {
      name: "Unicode whitespace",
      preview: "\u00a0\ufeff\u2028Unicode\u00a0\u2029text" + "x".repeat(4096),
      expected: "Unicode text" + "x".repeat(488),
    },
    {
      name: "formatting characters are preserved",
      preview: "\u200b\u202e" + "x".repeat(4096),
      expected: "\u200b\u202e" + "x".repeat(498),
    },
  ])("preserves $name in catalog previews", async ({ preview, expected }) => {
    const harness = createHarness();
    const request = harness.client.request<{ data: Array<{ id: string; preview: string }> }>(
      "thread/list",
      { limit: 1 },
      { timeoutMs: 1_000, catalogPreview: true },
    );
    harness.send({
      id: requestId(harness),
      result: { data: [{ id: "preview", projectId: null, preview }] },
    });
    await expect(request).resolves.toEqual({
      data: [{ id: "preview", projectId: null, preview: expected }],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, true] as const)(
    "keeps thread/list requests independent with catalogPreview=%s",
    async (catalogPreview) => {
      const harness = createHarness();
      const request = () =>
        harness.client.request("thread/list", { limit: 1 }, { timeoutMs: 1_000, catalogPreview });
      const first = request();
      const second = request();
      expect(harness.writes).toHaveLength(2);
      const frames = harness.writes.map((write) => JSON.parse(write));
      expect(frames[0].id).not.toBe(frames[1].id);
      const pages = ["first", "second"].map((id) => ({
        data: [{ id, ...(catalogPreview ? { projectId: null } : {}) }],
      }));
      harness.send({ id: frames[0].id, result: pages[0] });
      harness.send({ id: frames[1].id, result: pages[1] });
      await expect(Promise.all([first, second])).resolves.toEqual(pages);
    },
  );
});
