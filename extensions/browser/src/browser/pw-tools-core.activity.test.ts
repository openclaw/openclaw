// Browser tests cover Playwright observation filtering behavior.
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

describe("getPageTextViaPlaywright", () => {
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
    let settled = false;
    const pending = getPageTextViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
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
      expect(settled).toBe(true);
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
      contents: {
        ".excerpt": ["Selected", "Not selected"],
        article: ["Article"],
        main: ["Main"],
        body: ["Body"],
      },
      expected: "Selected",
    },
    {
      selector: undefined,
      contents: { article: ["Article", "Second article"], main: ["Main"], body: ["Body"] },
      expected: "Article",
    },
    { selector: undefined, contents: { main: ["Main"], body: ["Body"] }, expected: "Main" },
    { selector: undefined, contents: { body: ["Body"] }, expected: "Body" },
  ])(
    "extracts $expected using selector precedence and the first match",
    async ({ selector, contents, expected }) => {
      installTextPage(contents);
      expect(
        await getPageTextViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "T1",
          selector,
        }),
      ).toEqual({ text: expected, truncated: false });
    },
  );

  it("reports a missing explicit selector instead of reading unrelated body text", async () => {
    installTextPage({ body: ["Unrelated body"] });
    await expect(
      getPageTextViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", selector: ".missing" }),
    ).rejects.toThrow("Selector did not match");
  });

  it.each([undefined, 10, DEFAULT_AI_SNAPSHOT_MAX_CHARS * 2])(
    "bounds returned text for maxChars=%s",
    async (maxChars) => {
      const text = "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS + 1);
      installTextPage({ body: [text] });
      const result = await getPageTextViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", maxChars });
      expect(result).toEqual({
        text: text.slice(
          0,
          Math.min(maxChars ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS, DEFAULT_AI_SNAPSHOT_MAX_CHARS),
        ),
        truncated: true,
      });
    },
  );

  it("does not mark text that exactly fits the budget as truncated", async () => {
    installTextPage({ body: ["Exact"] });
    expect(
      await getPageTextViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", maxChars: 5 }),
    ).toEqual({ text: "Exact", truncated: false });
  });
});

describe("getNetworkRequestsViaPlaywright", () => {
  it.each(["fetch", "/api/"])(
    "filters requests by URL or resource type (%s) and clears the full buffer",
    async (filter) => {
      setPwToolsCoreCurrentPage({});
      const matching = {
        id: "1",
        url: "https://example.com/api/data",
        resourceType: "fetch",
        method: "GET",
        timestamp: "1",
      };
      const state = {
        console: [],
        requests: new Map([
          ["1", matching],
          [
            "2",
            { ...matching, id: "2", url: "https://example.com/logo.png", resourceType: "image" },
          ],
        ]),
        requestIds: new WeakMap(),
        armIdUpload: 0,
        armIdDownload: 0,
        downloadWaiterDepth: 0,
      };
      getPwToolsCoreSessionMocks().ensurePageState.mockReturnValueOnce(state);
      expect(
        await getNetworkRequestsViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          filter,
          clear: true,
        }),
      ).toEqual({ requests: [matching] });
      expect(state.requests).toEqual(new Map());
    },
  );
});

describe("getConsoleMessagesViaPlaywright", () => {
  it("treats the documented warn filter as warning priority", async () => {
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

    const messages = await getConsoleMessagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      level: "warn",
    });

    expect(messages.map((message) => message.type)).toEqual(["error", "warning"]);
  });
});
