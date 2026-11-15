import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdp from "./cdp.js";
import { OPEN_TAB_DISCOVERY_POLL_MS } from "./server-context.constants.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition, markBrowserRuntimeStopping } from "./server-context.lifecycle.js";
import {
  createTestBrowserRouteContext as testContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";
import type { BrowserTab } from "./server-context.types.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tab: BrowserTab = { targetId: "PAGE", title: "page", url: "about:blank", type: "page" };
function selection(listTabs: () => Promise<BrowserTab[]>) {
  const profile = makeBrowserProfile();
  const controller = new AbortController();
  const ops = createProfileSelectionOps({
    profile,
    runtime: { profile, running: null, lastTargetId: null },
    getCdpControlPolicy: () => undefined,
    listTabs,
    openTab: async () => tab,
  });
  return { controller, ensure: ops.ensureTabAvailable(undefined, { signal: controller.signal }) };
}

it.each(["caller", "deadline", "late"])("cancels listing (%s)", async (source) => {
  const started = Promise.withResolvers<void>();
  const request = Promise.withResolvers<Response>();
  let requestSignal: AbortSignal | null | undefined;
  globalThis.fetch = withBrowserFetchPreconnect(
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal;
      if (source !== "late") {
        requestSignal?.addEventListener(
          "abort",
          () => request.reject(new Error("tab listing aborted")),
          { once: true },
        );
      }
      started.resolve();
      return request.promise;
    }),
  );
  const state = makeState("openclaw");
  const profile = testContext({ getState: () => state }).forProfile("openclaw");
  const controller = new AbortController();
  const timeoutMs = source === "late" ? undefined : 25;
  const listing = profile.listTabs({ signal: controller.signal, timeoutMs });
  const rejected = listing.catch((error: unknown) => error);
  await started.promise;
  if (source === "deadline") {
    await vi.advanceTimersByTimeAsync(25);
  } else {
    controller.abort(new Error("listing cancelled"));
  }
  const lateTabs = [{ id: "LATE", title: "Late tab", url: "about:blank", type: "page" }];
  request.resolve(Response.json(source === "late" ? lateTabs : []));
  if (source !== "late") {
    expect(requestSignal?.aborted).toBe(true);
  }
  const error = await rejected;
  expect(error).toBeInstanceOf(Error);
  if (source === "late") {
    expect(error).toMatchObject({ message: "listing cancelled" });
  }
  expect(state.profiles.get("openclaw")?.tabAliases).toBeUndefined();
});

it.each([false, true])("cancels selection (in-flight=%s)", async (inFlight) => {
  const request = Promise.withResolvers<BrowserTab[]>();
  const listTabs = vi
    .fn()
    .mockImplementationOnce(() => (inFlight ? request.promise : Promise.resolve([tab])))
    .mockResolvedValue([tab]);
  const { controller, ensure } = selection(listTabs);
  await vi.advanceTimersByTimeAsync(0);
  expect(inFlight ? listTabs.mock.calls.length : vi.getTimerCount()).toBe(1);
  controller.abort();
  if (inFlight) {
    request.resolve([{ ...tab, wsUrl: "ws://127.0.0.1/devtools/page/PAGE" }]);
  }
  await expect(ensure).rejects.toThrow(/aborted/i);
  expect(listTabs).toHaveBeenCalledTimes(inFlight ? 1 : 2);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels opened-target discovery on shutdown even when compensating close fails", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const created = { targetId: "PENDING", finalUrl: "about:blank" };
  vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue(created);
  const closes: Array<[string, boolean | undefined]> = [];
  globalThis.fetch = withBrowserFetchPreconnect(
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/json/close/")) {
        closes.push([String(url), init?.signal?.aborted]);
        throw new Error("close request failed");
      }
      if (String(url).includes("/json/list")) {
        return Response.json([]);
      }
      throw new Error("unexpected fetch: " + String(url));
    }),
  );
  const state = makeState("openclaw");
  const openclaw = createBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  const open = openclaw.openTab("about:blank", { signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(0);
  expect(timers.mock.calls.some((call) => call[1] === OPEN_TAB_DISCOVERY_POLL_MS)).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  markBrowserRuntimeStopping(state);
  const stopping = beginProfileTransition({
    state,
    runtime: state.profiles.get("openclaw")!,
    reason: "runtime shutdown",
    closeSharedAdapters: false,
  });
  await expect(open).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
  expect(closes).toEqual([["http://127.0.0.1:18800/json/close/PENDING", false]]);
  await stopping;
  expect(vi.getTimerCount()).toBe(0);
});
