import { expect, it, vi } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS, DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import { heldAction } from "./pw-tools-core.guard-test-support.js";
import * as harness from "./pw-tools-core.test-harness.js";

harness.installPwToolsCoreTestHooks();
const {
  getConsoleMessagesViaPlaywright: readConsole,
  getNetworkRequestsViaPlaywright: readRequests,
  getPageTextViaPlaywright: readText,
} = await import("./pw-tools-core.activity.js");
const target = { cdpUrl: "http://127.0.0.1:18792" };
const session = harness.getPwToolsCoreSessionMocks();
const expectedUrl = "https://example.com/current";
const changed = "Page text target changed or closed; refresh tabs and retry.";

function installTextPage(
  contents: Record<string, string>,
  overrides: { count?: () => Promise<number>; innerText?: () => Promise<string> } = {},
  page: Record<string, unknown> = {},
) {
  harness.setPwToolsCoreCurrentPage({
    ...page,
    locator: (selector: string) => ({
      first: () => ({
        count: async () => (selector in contents ? 1 : 0),
        innerText: async () =>
          contents[selector] ?? Promise.reject(new Error("Selector did not match an element")),
        ...overrides,
      }),
    }),
  });
}

it.each(["cancel", "timeout"])("settles a stalled selector probe on %s", async (reason) => {
  vi.useFakeTimers();
  const probe = heldAction<number>();
  const innerText = vi.fn(async () => "late text");
  installTextPage({}, { count: probe.run, innerText });
  const controller = new AbortController();
  const pending = readText({ ...target, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow(
    reason === "cancel" ? "cancel text" : /timed out/i,
  );
  try {
    await probe.started;
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

it.each([
  [".excerpt", undefined, "Selected", false],
  [undefined, 2, "Bo", true],
  [undefined, 3, "A😀", true],
  ["article", 2, "A", true],
  ["article", 3, "A😀", true],
  ["article", 4, "A😀B", false],
  ["main", DEFAULT_AI_SNAPSHOT_MAX_CHARS * 2, "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS), true],
] as const)("extracts bounded text from %s (%s)", async (selector, maxChars, text, truncated) => {
  const contents = {
    ".excerpt": "Selected",
    article: "A😀B",
    main: "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS + 1),
  };
  installTextPage(selector || maxChars === 3 ? contents : { body: "Body" });
  expect(await readText({ ...target, selector, maxChars })).toEqual({ text, truncated });
});

type PageChange = { url?: string; closed?: boolean };

/** Page whose CDP frame tree reports these main-frame loader ids, one per read. */
function installDocumentPage(
  loaderIds: Array<string | undefined>,
  before: PageChange = {},
  during: PageChange = {},
) {
  const state = { url: expectedUrl, closed: false, ...before };
  const pending = [...loaderIds];
  const send = async () => ({ frameTree: { frame: { id: "main", loaderId: pending.shift() } } });
  const context = { newCDPSession: async () => ({ send, detach: async () => {} }) };
  const innerText = vi.fn(async () => {
    Object.assign(state, during);
    return "Body";
  });
  const page = { url: () => state.url, isClosed: () => state.closed, context: () => context };
  installTextPage({ body: "Body" }, { innerText }, page);
  return innerText;
}

it.each([
  ["one document", ["first", "first"]],
  ["an endpoint without document identities", [undefined, undefined]],
])("returns text read within %s", async (_name, loaderIds) => {
  installDocumentPage(loaderIds);
  expect(await readText({ ...target, expectedUrl })).toEqual({ text: "Body", truncated: false });
});

it.each<[string, Array<string | undefined>, PageChange, PageChange, number]>([
  ["loads another document", ["first", "second"], {}, {}, 1],
  ["gains a document identity", [undefined, "second"], {}, {}, 1],
  ["left the expected URL", [], { url: "https://example.com/old" }, {}, 0],
  ["was closed", [], { closed: true }, {}, 0],
  ["navigates during the read", ["first", "first"], {}, { url: "https://example.com/b" }, 1],
  ["closes during the read", ["first", "first"], {}, { closed: true }, 1],
])("rejects text when the page %s", async (_name, loaderIds, before, during, reads) => {
  const innerText = installDocumentPage(loaderIds, before, during);
  await expect(readText({ ...target, expectedUrl })).rejects.toThrow(changed);
  expect(innerText).toHaveBeenCalledTimes(reads);
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
