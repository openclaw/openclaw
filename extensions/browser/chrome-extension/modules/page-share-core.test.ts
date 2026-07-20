import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPageSharePayload, capturePageShare } from "./page-share-core.js";

const PAGE_SHARE_MAX_CONTENT_CHARS = 120_000;
const PAGE_SHARE_MAX_NOTE_CHARS = 2_000;
const PAGE_SHARE_MAX_TITLE_CHARS = 500;
const PAGE_SHARE_MAX_URL_CHARS = 2_000;

describe("page share core", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports Google documents in the tab using the document id", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: "" }])
      .mockResolvedValueOnce([{ result: { text: "Document body" } }]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await expect(
      capturePageShare({
        id: 17,
        url: "https://docs.google.com/document/d/document-id_123/edit?tab=t.0",
        title: "Document",
      }),
    ).resolves.toEqual({
      url: "https://docs.google.com/document/d/document-id_123/edit?tab=t.0",
      title: "Document",
      selection: "",
      content: "Document body",
    });
    expect(executeScript.mock.calls[1]?.[0]).toMatchObject({
      target: { tabId: 17 },
      args: ["document-id_123", 30_000],
    });
  });

  it("aborts a stalled Google Docs export and returns its error", async () => {
    type ExecuteScriptDetails = {
      args?: unknown[];
      func: (...args: unknown[]) => unknown;
    };
    let exportCall: ExecuteScriptDetails | undefined;
    const executeScript = vi.fn(async (details: ExecuteScriptDetails) => {
      if (!details.args) {
        return [{ result: "" }];
      }
      exportCall = details;
      const result = await details.func(details.args[0], 1);
      return [{ result }];
    });
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(new Error("Expected export timeout signal"));
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
            ),
          { once: true },
        );
      });
    });
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      capturePageShare({
        id: 17,
        url: "https://docs.google.com/document/d/document-id_123/edit",
        title: "Document",
      }),
    ).rejects.toThrow(/timeout|abort/i);
    expect(exportCall?.args).toEqual(["document-id_123", 30_000]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://docs.google.com/document/d/document-id_123/export?format=txt",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts a Google Docs export stalled while reading the response body", async () => {
    const executeScript = vi.fn(
      async (details: { args?: unknown[]; func: (...args: unknown[]) => unknown }) => {
        if (!details.args) {
          return [{ result: "" }];
        }
        const result = await details.func(details.args[0], 1);
        return [{ result }];
      },
    );
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        return Promise.reject(new Error("Expected export timeout signal"));
      }
      const body = new ReadableStream({
        start(controller) {
          const abort = () => controller.error(signal.reason);
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
          }
        },
      });
      return Promise.resolve(new Response(body));
    });
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      capturePageShare({
        id: 17,
        url: "https://docs.google.com/document/d/document-id_123/edit",
        title: "Document",
      }),
    ).rejects.toThrow(/timeout|abort/i);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://docs.google.com/document/d/document-id_123/export?format=txt",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps text at the boundary and marks truncation beyond it", () => {
    const atBoundary = buildPageSharePayload({
      url: "https://example.com",
      title: "Example",
      content: "x".repeat(PAGE_SHARE_MAX_CONTENT_CHARS),
    });
    const beyondBoundary = buildPageSharePayload({
      url: "https://example.com",
      title: "Example",
      content: "x".repeat(PAGE_SHARE_MAX_CONTENT_CHARS + 1),
    });
    expect(atBoundary.content).toHaveLength(PAGE_SHARE_MAX_CONTENT_CHARS);
    expect(
      beyondBoundary.content.endsWith(
        `[Truncated: original was ${PAGE_SHARE_MAX_CONTENT_CHARS + 1} characters]`,
      ),
    ).toBe(true);
  });

  it("trims fields, preserves newlines, applies caps, and drops empty optionals", () => {
    const payload = buildPageSharePayload({
      url: ` https://example.com/${"u".repeat(PAGE_SHARE_MAX_URL_CHARS)} `,
      title: ` ${"t".repeat(PAGE_SHARE_MAX_TITLE_CHARS + 10)} `,
      content: `  first   line  \n second\tline ${"c".repeat(PAGE_SHARE_MAX_CONTENT_CHARS)} `,
      selection: "   ",
      note: ` ${"n".repeat(PAGE_SHARE_MAX_NOTE_CHARS + 10)} `,
    });

    expect(payload.url).toHaveLength(PAGE_SHARE_MAX_URL_CHARS);
    expect(payload.title).toHaveLength(PAGE_SHARE_MAX_TITLE_CHARS);
    expect(payload.content).toContain("first line \n second line");
    expect(payload.content).toContain("[Truncated: original was");
    expect(payload.note).toHaveLength(PAGE_SHARE_MAX_NOTE_CHARS);
    expect(payload).not.toHaveProperty("selection");
  });

  it("keeps the injected capture function self-contained", async () => {
    const executeScript = vi.fn().mockResolvedValue([
      {
        result: {
          url: "https://example.com",
          title: "Example",
          selection: "",
          content: "Body",
        },
      },
    ]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await capturePageShare({ id: 9, url: "https://example.com", title: "Example" });
    const source = String(executeScript.mock.calls[0]?.[0].func);
    expect(source).not.toMatch(/\b(?:import|require)\b/u);
  });
});
