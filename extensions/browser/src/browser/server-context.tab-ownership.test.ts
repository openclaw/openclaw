import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpModule from "./cdp.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("browser tab ownership probes", () => {
  it("rejects a non-durable dashboard open and compensates through its captured managed endpoint", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "CREATED",
      finalUrl: "http://127.0.0.1:8080",
    });
    const state = makeState("openclaw");
    const closeRequests: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        return {
          ok: true,
          json: async () => [
            { id: "CREATED", title: "New Tab", url: "http://127.0.0.1:8080", type: "page" },
          ],
        } as unknown as Response;
      }
      if (value.includes("/json/version")) {
        state.resolved.profiles.openclaw = {
          driver: "existing-session",
          cdpUrl: "http://127.0.0.1:19999",
          color: "#FF4500",
        };
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      if (value.includes("/json/close/CREATED")) {
        closeRequests.push(value);
        return { ok: true } as Response;
      }
      throw new Error(`unexpected fetch: ${value}`);
    });
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );
    await expect(
      openclaw.openTab("http://127.0.0.1:8080", { requireDurableOwnership: true }),
    ).rejects.toThrow(/could not verify durable ownership/);
    expect(closeRequests).toEqual(["http://127.0.0.1:18800/json/close/CREATED"]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":19999"))).toBe(false);
  });
  it.each([false, true])(
    "propagates caller abort through the managed ownership version probe (close fails: %s)",
    async (closeFails) => {
      vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
        targetId: "CREATED",
        finalUrl: "http://127.0.0.1:8080",
      });
      let versionSignal: AbortSignal | undefined;
      const closeRequests: string[] = [];
      let markProbeStarted!: () => void;
      const probeStarted = new Promise<void>((resolve) => {
        markProbeStarted = resolve;
      });
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const value = String(url);
        if (value.includes("/json/list")) {
          return {
            ok: true,
            json: async () => [
              {
                id: "CREATED",
                title: "New Tab",
                url: "http://127.0.0.1:8080",
                webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
                type: "page",
              },
            ],
          } as unknown as Response;
        }
        if (value.includes("/json/version")) {
          versionSignal = init?.signal ?? undefined;
          markProbeStarted();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  init.signal?.reason instanceof Error
                    ? init.signal.reason
                    : new Error("managed ownership probe aborted"),
                ),
              { once: true },
            );
          });
        }
        if (value.includes("/json/close/CREATED")) {
          closeRequests.push(value);
          if (closeFails) {
            throw new Error("close request failed");
          }
          return { ok: true } as Response;
        }
        throw new Error(`unexpected fetch: ${value}`);
      });
      global.fetch = withBrowserFetchPreconnect(fetchMock);
      const state = makeState("openclaw");
      const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
        "openclaw",
      );
      const controller = new AbortController();
      const abortError = new Error("caller aborted managed ownership probe");

      const opening = openclaw.openTab("http://127.0.0.1:8080", {
        signal: controller.signal,
      });
      await probeStarted;
      controller.abort(abortError);
      const propagatedImmediately = versionSignal?.aborted;

      await expect(opening).rejects.toBe(abortError);
      expect(propagatedImmediately).toBe(true);
      expect(closeRequests).toEqual(["http://127.0.0.1:18800/json/close/CREATED"]);
    },
  );
});
