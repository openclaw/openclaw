import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeCodexCatalogFrame } from "./client-catalog-response.js";
import * as messageDecoder from "./client-message-decoder.js";
import type { CodexThreadListParams } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

const harnesses: Array<ReturnType<typeof createClientHarness>> = [];
const prefix = "x".repeat(499);
const tail = "y".repeat(4096);
const fittingPair = "x".repeat(498) + "😀";
const oscPayload = "p".repeat(3000);

it("normalizes and copies each bounded worker preview only once", () => {
  const preview = "synthetic preview ".padEnd(500, "x");
  const id = Number.MAX_SAFE_INTEGER - 2;
  const bytes = Buffer.from(
    JSON.stringify({
      id,
      result: {
        data: Array.from({ length: 16 }, (_, index) => ({
          id: `thread-${index}`,
          preview: preview + " discarded".repeat(8192),
        })),
        nextCursor: "next",
      },
    }),
  );
  const copies = vi.spyOn(Buffer, "from");
  const replacements = vi.spyOn(String.prototype, "replace");
  const decoded = decodeCodexCatalogFrame({ bytes, route: { id, kind: "list" } });
  expect(decoded.message).toEqual({
    id,
    result: {
      data: Array.from({ length: 16 }, (_, index) => ({
        id: `thread-${index}`,
        projectId: null,
        preview,
      })),
      nextCursor: "next",
    },
  });
  expect(copies.mock.calls.filter(([value]) => value === preview)).toHaveLength(16);
  expect(
    replacements.mock.calls.filter(
      ([pattern]) => pattern instanceof RegExp && pattern.source === "\\s+",
    ),
  ).toHaveLength(16);
});

function createHarness() {
  const harness = createClientHarness({ autoEmitExit: false });
  harnesses.push(harness);
  return Object.assign(harness, {
    list: (
      options: Parameters<typeof harness.client.request>[2],
      params: CodexThreadListParams = { limit: 64 },
    ) => harness.client.request("thread/list", params, options),
    reply: (result: unknown, index = 0) => harness.send({ id: requestId(harness, index), result }),
  });
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

it.each([0, 1])(
  "projects only the remaining %i catalog rows without shrinking the native page",
  async (catalogRows) => {
    const harness = createHarness();
    const selected = {
      id: "selected",
      projectId: null,
      preview: "Kept first user request",
      cwd: "/workspace/selected",
    };
    const cache = vi.fn((thread: { id: string }) => {
      if (catalogRows === 0 || thread.id !== "selected") {
        throw new Error("Discarded rows must not read the resident preview cache");
      }
      return undefined;
    });
    const request = harness.list(
      { timeoutMs: 1_000, catalogPreview: true, catalogPreviewCache: cache, catalogRows },
      { limit: 64, cursor: "native-start", useStateDbOnly: true },
    );
    const frame = JSON.parse(harness.writes[0]!);
    expect(frame).toMatchObject({
      method: "thread/list",
      params: { limit: 64, cursor: "native-start", useStateDbOnly: true },
    });
    expect(frame.params).not.toHaveProperty("catalogRows");
    harness.reply({
      data: Array.from({ length: 64 }, (_, index) =>
        index === 0
          ? { ...selected, preview: `\u001b[32m${selected.preview}\u001b[0m` }
          : {
              id: `discarded-${index}`,
              preview: "Discarded preview ".repeat(1024),
              path: "/".repeat(4097),
              turns: [{ items: [{ text: "Discarded transcript ".repeat(1024) }] }],
            },
      ),
      nextCursor: "opaque-native-next",
      backwardsCursor: "opaque-native-previous",
    });
    await expect(request).resolves.toEqual({
      data: catalogRows ? [selected] : [],
      nextCursor: "opaque-native-next",
      backwardsCursor: "opaque-native-previous",
    });
    expect(cache.mock.calls.map(([thread]) => thread.id)).toEqual(catalogRows ? ["selected"] : []);
    expect(harness.writes).toHaveLength(1);
  },
);

it("bounds catalog payloads while preserving ordinary thread/list results", async () => {
  const parse = vi.spyOn(messageDecoder, "parseCodexAppServerMessage");
  const harness = createHarness();
  // Stay below the 8 MiB frame cap while exercising worker-side projection.
  const large = "unused native history ".repeat(80_000);
  const thread = {
    id: "bounded-metadata",
    preview: "x".repeat(1024 * 1024),
    cwd: "/workspace/project",
    name: "Sidebar review",
    gitInfo: { branch: "catalog-fix", sha: large, originUrl: large },
    extra: { payload: large },
    turns: [{ items: [{ text: large }] }],
  };
  const catalog = harness.list(
    { timeoutMs: 1_000, catalogPreview: true },
    { limit: 64, useStateDbOnly: true },
  );
  expect(Buffer.byteLength(JSON.stringify(thread))).toBeLessThan(8 * 1024 * 1024);
  harness.reply({ data: [thread] });
  const page = await catalog;
  expect(page.data[0]).toMatchObject({
    id: thread.id,
    preview: "x".repeat(500),
    cwd: thread.cwd,
    name: thread.name,
    gitInfo: { branch: "catalog-fix" },
  });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2_048);
  expect(parse).not.toHaveBeenCalled();
  const ordinaryThread = { ...thread, preview: thread.preview.repeat(2) };
  expect(Buffer.byteLength(JSON.stringify(ordinaryThread))).toBeGreaterThan(8 * 1024 * 1024);
  const ordinary = harness.client.request("thread/list", { limit: 64, useStateDbOnly: true });
  harness.reply({ data: [ordinaryThread] }, 1);
  await expect(ordinary).resolves.toEqual({ data: [ordinaryThread] });
  expect(parse).toHaveBeenCalledOnce();
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
    const request = harness.list({ catalogPreview: true, catalogPreviewCache: cache });
    harness.reply({
      data: cases.map(({ id, preview }) => ({ id, preview })),
      unused: "x".repeat(padding),
    });
    await expect(request).resolves.toEqual({
      data: cases.map(({ id, expected }) => ({ id, projectId: null, preview: expected })),
    });
    expect(cache.mock.calls.map(([thread]) => thread.id)).toEqual(cases.map(({ id }) => id));
  },
);

it.each([
  ["leading whitespace beyond the input prefix", " \t\n".repeat(4096) + "visible", "visible"],
  ["whitespace before ANSI removal", "a \u001b[0m b", "a  b"],
  ["space at the output boundary", prefix + " " + tail, prefix + " "],
  ["trailing whitespace beyond the input prefix", prefix + " \n\t".repeat(4096), prefix],
  ["surrogate pair across the output boundary", prefix + "😀" + tail, prefix],
  ["surrogate pair fitting the output boundary", fittingPair + tail, fittingPair],
  ["surrogate lookahead after trim", " ".repeat(1548) + prefix + "😀tail", prefix],
  ["lone surrogate at the output boundary", prefix + "\ud800" + tail, prefix + "\ufffd"],
  ["C0 removal after trim", "a\u0000b \u007f c".repeat(400), "ab  c".repeat(100)],
  ["OSC terminator beyond input prefix", "\u001b]0;" + oscPayload + "\u0007visible", "visible"],
  ["unterminated OSC payload", "\u001b]0;" + oscPayload, "]0;" + "p".repeat(497)],
  ["C1 CSI crossing the input prefix", "\u009b" + "1;".repeat(1500) + "31mvisible", "visible"],
])("preserves %s in catalog previews", async (_name, preview, expected) => {
  const harness = createHarness();
  const request = harness.list({ timeoutMs: 1_000, catalogPreview: true }, { limit: 1 });
  harness.reply({ data: [{ id: "preview", projectId: null, preview }] });
  await expect(request).resolves.toEqual({
    data: [{ id: "preview", projectId: null, preview: expected }],
  });
  expect(vi.getTimerCount()).toBe(0);
});
