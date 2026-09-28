import { afterEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpHelpersModule from "./cdp.helpers.js";
import * as cdpModule from "./cdp.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

afterEach(async () => {
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  await closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function seedRunningProfileState(
  state: ReturnType<typeof makeState>,
  profileName = "openclaw",
): void {
  (state.profiles as Map<string, unknown>).set(profileName, {
    profile: { name: profileName },
    running: { pid: 1234, proc: { on: vi.fn() } },
    lastTargetId: null,
  });
}

describe("browser server-context tab selection lookup state", () => {
  it("preserves the opened tab lookup when a same-target listing lacks a WebSocket URL", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockRejectedValue(new Error("raw create failed"));
    vi.spyOn(cdpModule, "waitForCdpCommittedNavigationUrl").mockResolvedValue(undefined);
    let listCalls = 0;
    const lookupHosts: string[] = [];
    const fetchJson = vi.spyOn(cdpHelpersModule, "fetchJson").mockImplementation(async (url) => {
      if (url.includes("/json/list")) {
        listCalls += 1;
        return listCalls === 1
          ? []
          : [
              {
                id: "NEW",
                title: "Listed",
                url: "about:blank",
                type: "page",
              },
            ];
      }
      if (url.includes("/json/new")) {
        return {
          id: "NEW",
          title: "Opened",
          url: "about:blank",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/NEW",
          type: "page",
        };
      }
      throw new Error(`unexpected fetchJson: ${url}`);
    });
    vi.spyOn(cdpHelpersModule, "assertCdpEndpointAllowed").mockImplementation(async () => ({
      hostname: "browser.example",
      addresses: ["127.0.0.1"],
      lookup: ((hostname: string, _options: unknown, callback?: unknown) => {
        lookupHosts.push(hostname);
        if (typeof callback === "function") {
          callback(null, "127.0.0.1", 4);
        }
      }) as never,
    }));
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    seedRunningProfileState(state);
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    const selected = await openclaw.ensureTabAvailable();

    expect(selected).toEqual(
      expect.objectContaining({
        targetId: "NEW",
        title: "Listed",
        url: "about:blank",
        wsUrl: "ws://127.0.0.1:18800/devtools/page/NEW",
      }),
    );
    expect(selected.wsLookup).toBeTypeOf("function");
    selected.wsLookup?.("browser.example", {}, () => {});
    expect(lookupHosts).toEqual(["browser.example"]);
    expect(fetchJson.mock.calls.some(([url]) => url.includes("/json/new"))).toBe(true);
  });
});
