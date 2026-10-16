import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS, DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const {
  getConsoleMessagesViaPlaywright,
  getNetworkRequestsViaPlaywright,
  getPageTextViaPlaywright,
} = await import("./pw-tools-core.activity.js");
const target = { cdpUrl: "http://127.0.0.1:18792" };

function installTextPage(contents: Record<string, string[]>) {
  setPwToolsCoreCurrentPage({
    locator: (selector: string) => ({
      first: () => ({
        count: async () => (contents[selector]?.length ? 1 : 0),
        innerText: async () => {
          const text = contents[selector]?.[0];
          if (text === undefined) {
            throw new Error("Selector did not match an element");
          }
          return text;
        },
      }),
    }),
  });
}

describe("page activity", () => {
  it.each(["cancel", "timeout"])("settles a stalled selector probe on %s", async (reason) => {
    vi.useFakeTimers();
    const probe = createDeferred<number>();
    const entered = createDeferred<void>();
    const innerText = vi.fn(async () => "late text");
    setPwToolsCoreCurrentPage({
      locator: () => ({
        first: () => ({
          count: () => {
            entered.resolve();
            return probe.promise;
          },
          innerText,
        }),
      }),
    });
    const controller = new AbortController();
    const settled = vi.fn();
    const pending = getPageTextViaPlaywright({ ...target, signal: controller.signal }).finally(
      settled,
    );
    const rejected = expect(pending).rejects.toThrow(
      reason === "cancel" ? "cancel text" : /timed out/i,
    );
    try {
      await entered.promise;
      if (reason === "cancel") {
        controller.abort(new Error("cancel text"));
      } else {
        await vi.advanceTimersByTimeAsync(DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      probe.resolve(1);
      await pending.catch(() => {});
      await rejected;
      vi.useRealTimers();
    }
    expect(innerText).not.toHaveBeenCalled();
  });

  it.each<{ selector?: string; contents: Record<string, string[]>; expected: string }>([
    {
      selector: ".excerpt",
      contents: { ".excerpt": ["Selected", "Not selected"], article: ["Article"], body: ["Body"] },
      expected: "Selected",
    },
    { contents: { body: ["Body"] }, expected: "Body" },
  ])(
    "extracts $expected using the first matching element",
    async ({ selector, contents, expected }) => {
      installTextPage(contents);
      expect(await getPageTextViaPlaywright({ ...target, selector })).toEqual({
        text: expected,
        truncated: false,
      });
    },
  );

  it("caps article text even when the requested budget exceeds the limit", async () => {
    const text = "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS + 1);
    installTextPage({ article: [text, "Second article"], main: ["Main"], body: ["Body"] });
    expect(
      await getPageTextViaPlaywright({ ...target, maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS * 2 }),
    ).toEqual({ text: text.slice(0, DEFAULT_AI_SNAPSHOT_MAX_CHARS), truncated: true });
  });

  it("filters by URL or resource type and clears the full network buffer", async () => {
    setPwToolsCoreCurrentPage({});
    const byUrl = {
      id: "1",
      url: "https://example.com/fetch",
      resourceType: "document",
      method: "GET",
      timestamp: "1",
    };
    const byType = { ...byUrl, id: "2", url: "https://example.com/api", resourceType: "fetch" };
    const state = {
      console: [],
      requests: new Map([
        ["1", byUrl],
        ["2", byType],
        ["3", { ...byUrl, id: "3", url: "https://example.com/logo", resourceType: "image" }],
      ]),
      requestIds: new WeakMap(),
      armIdUpload: 0,
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    };
    getPwToolsCoreSessionMocks().ensurePageState.mockReturnValueOnce(state);
    expect(
      await getNetworkRequestsViaPlaywright({ ...target, filter: "fetch", clear: true }),
    ).toEqual({ requests: [byUrl, byType] });
    expect(state.requests).toEqual(new Map());
  });

  it("treats warn as warning priority", async () => {
    setPwToolsCoreCurrentPage({});
    getPwToolsCoreSessionMocks().ensurePageState.mockReturnValueOnce({
      console: [
        { type: "error", text: "error", timestamp: "1" },
        { type: "warning", text: "warning", timestamp: "2" },
        { type: "info", text: "info", timestamp: "3" },
      ],
      armIdUpload: 0,
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    });
    expect(
      (await getConsoleMessagesViaPlaywright({ ...target, level: "warn" })).map(
        (message) => message.type,
      ),
    ).toEqual(["error", "warning"]);
  });
});
