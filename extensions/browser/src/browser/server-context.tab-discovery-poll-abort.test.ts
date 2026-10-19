import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdp from "./cdp.js";
import { OPEN_TAB_DISCOVERY_POLL_MS } from "./server-context.constants.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition, markBrowserRuntimeStopping } from "./server-context.lifecycle.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";
import type { BrowserTab } from "./server-context.types.js";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}

const tab: BrowserTab = {
  targetId: "PAGE",
  title: "page",
  url: "http://127.0.0.1:3001",
  type: "page",
};
function selection(listTabs: () => Promise<(typeof tab)[]>) {
  const profile = makeBrowserProfile();
  return createProfileSelectionOps({
    profile,
    runtime: { profile, running: null, lastTargetId: null },
    getCdpControlPolicy: () => undefined,
    listTabs,
    openTab: async () => tab,
  });
}

describe("browser tab discovery cancellation", () => {
  it.each(["caller", "deadline"])("cancels an in-flight local listing on %s", async (source) => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const request = Promise.withResolvers<Response>();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = withBrowserFetchPreconnect(
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestSignal = init?.signal;
        requestSignal?.addEventListener(
          "abort",
          () => request.reject(new Error("tab listing aborted")),
          { once: true },
        );
        started.resolve();
        return request.promise;
      }),
    );
    const state = makeState("openclaw");
    const profile = createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    const controller = new AbortController();
    const rejected = profile
      .listTabs({ signal: controller.signal, timeoutMs: 25 })
      .catch((error: unknown) => error);
    await started.promise;
    if (source === "caller") {
      controller.abort(new Error("listing cancelled"));
    } else {
      await vi.advanceTimersByTimeAsync(25);
    }
    try {
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      request.resolve(Response.json([]));
    }
    expect(await rejected).toBeInstanceOf(Error);
    expect(state.profiles.get("openclaw")?.tabAliases).toBeUndefined();
  });

  it("does not adopt a local listing returned after cancellation", async () => {
    const started = Promise.withResolvers<void>();
    const request = Promise.withResolvers<Response>();
    globalThis.fetch = withBrowserFetchPreconnect(
      vi.fn(async () => {
        started.resolve();
        return request.promise;
      }),
    );
    const state = makeState("openclaw");
    const profile = createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
    const controller = new AbortController();
    const rejected = expect(profile.listTabs({ signal: controller.signal })).rejects.toThrow(
      "listing cancelled",
    );
    await started.promise;
    controller.abort(new Error("listing cancelled"));
    request.resolve(
      Response.json([{ id: "LATE", title: "Late tab", url: "about:blank", type: "page" }]),
    );
    await rejected;
    expect(state.profiles.get("openclaw")?.tabAliases).toBeUndefined();
  });

  it("cancels the selection discovery timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const ensure = selection(async () => [tab]).ensureTabAvailable(undefined, {
      signal: controller.signal,
    });
    await flushUntil(() => vi.getTimerCount() === 1);
    controller.abort();
    await expect(ensure).rejects.toThrow(/aborted/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an in-flight selection read that succeeds after abort", async () => {
    vi.useFakeTimers();
    const request = Promise.withResolvers<(typeof tab)[]>();
    const listTabs = vi
      .fn()
      .mockImplementationOnce(() => request.promise)
      .mockResolvedValue([tab]);
    const controller = new AbortController();
    const ensure = selection(listTabs).ensureTabAvailable(undefined, { signal: controller.signal });
    await flushUntil(() => listTabs.mock.calls.length === 1);
    controller.abort();
    request.resolve([{ ...tab, wsUrl: "ws://127.0.0.1/devtools/page/PAGE" }]);
    await expect(ensure).rejects.toThrow(/aborted/i);
    expect(listTabs).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels opened-target discovery on shutdown even when compensating close fails", async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue({
      targetId: "PENDING",
      finalUrl: "about:blank",
    });
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
});
