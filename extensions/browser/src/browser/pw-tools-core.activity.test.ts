import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS, DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import * as harness from "./pw-tools-core.test-harness.js";

harness.installPwToolsCoreTestHooks();
const {
  getConsoleMessagesViaPlaywright: readConsole,
  getNetworkRequestsViaPlaywright: readRequests,
  getPageTextViaPlaywright: readText,
} = await import("./pw-tools-core.activity.js");
const target = { cdpUrl: "http://127.0.0.1:18792" };
const session = harness.getPwToolsCoreSessionMocks();

function installTextPage(
  contents: Record<string, string[]>,
  overrides: { count?: () => Promise<number>; innerText?: () => Promise<string> } = {},
) {
  harness.setPwToolsCoreCurrentPage({
    locator: (selector: string) => ({
      first: () => ({
        count: async () => (contents[selector]?.length ? 1 : 0),
        innerText: async () =>
          contents[selector]?.[0] ?? Promise.reject(new Error("Selector did not match an element")),
        ...overrides,
      }),
    }),
  });
}

it.each(["cancel", "timeout"])("settles a stalled selector probe on %s", async (reason) => {
  vi.useFakeTimers();
  const probe = createDeferred<number>();
  const entered = createDeferred<void>();
  const innerText = vi.fn(async () => "late text");
  const count = () => {
    entered.resolve();
    return probe.promise;
  };
  installTextPage({}, { count, innerText });
  const controller = new AbortController();
  const pending = readText({ ...target, signal: controller.signal });
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
    await rejected;
  } finally {
    probe.resolve(1);
    await pending.catch(() => {});
    vi.useRealTimers();
  }
  expect(innerText).not.toHaveBeenCalled();
});

it.each([".excerpt", undefined])("extracts the first matching element (%s)", async (selector) => {
  const contents: Record<string, string[]> = selector
    ? { ".excerpt": ["Selected", "Not selected"], article: ["Article"], body: ["Body"] }
    : { body: ["Body"] };
  installTextPage(contents);
  expect(await readText({ ...target, selector })).toEqual({
    text: selector ? "Selected" : "Body",
    truncated: false,
  });
});

it("caps article text at the hard limit", async () => {
  const text = "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS + 1);
  installTextPage({ article: [text, "Second article"], main: ["Main"], body: ["Body"] });
  expect(await readText({ ...target, maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS * 2 })).toEqual({
    text: text.slice(0, DEFAULT_AI_SNAPSHOT_MAX_CHARS),
    truncated: true,
  });
});

it("filters by URL or resource type and clears the full network buffer", async () => {
  harness.setPwToolsCoreCurrentPage({});
  const byUrl = { id: "1", url: "https://x/fetch", resourceType: "document" };
  const byType = { id: "2", url: "https://x/api", resourceType: "fetch" };
  const requests = [byUrl, byType, { id: "3", url: "https://x/logo", resourceType: "image" }];
  const state = {
    ...session.ensurePageState(),
    requests: new Map(requests.map((request) => [request.id, request])),
    requestIds: new WeakMap(),
  };
  session.ensurePageState.mockReturnValueOnce(state);
  expect(await readRequests({ ...target, filter: "fetch", clear: true })).toEqual({
    requests: [byUrl, byType],
  });
  expect(state.requests).toEqual(new Map());
});

it("treats warn as warning priority", async () => {
  harness.setPwToolsCoreCurrentPage({});
  session.ensurePageState.mockReturnValueOnce({
    ...session.ensurePageState(),
    console: ["error", "warning", "info"].map((type) => ({ type, text: type, timestamp: "1" })),
  });
  const messages = await readConsole({ ...target, level: "warn" });
  expect(messages.map((message) => message.type)).toEqual(["error", "warning"]);
});
