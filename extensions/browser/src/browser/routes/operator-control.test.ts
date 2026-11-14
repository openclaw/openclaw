import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig } from "../config.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { createBrowserRouteDispatcher } from "./dispatcher.js";

const PAUSED =
  "Browser input paused while the operator has control; wait until they release control in the Browser panel";

function createContext(cdpUrl: string, aliasCdpUrl?: string) {
  const state: BrowserServerState = {
    port: 0,
    resolved: resolveBrowserConfig({
      defaultProfile: "fixture",
      evaluateEnabled: false,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      profiles: {
        fixture: { cdpUrl, color: "#123456", attachOnly: true },
        ...(aliasCdpUrl
          ? { alias: { cdpUrl: aliasCdpUrl, color: "#654321", attachOnly: true } }
          : {}),
      },
    }),
    profiles: new Map(),
  };
  return createBrowserRouteContext({ getState: () => state });
}

function createDispatcher(cdpUrl: string, aliasCdpUrl?: string) {
  return createBrowserRouteDispatcher(createContext(cdpUrl, aliasCdpUrl));
}

/** A Control UI connection as `browser.request` presents it to the routes. */
function operatorConnection(connId: string) {
  const connection = new AbortController();
  return {
    requester: { connId, signal: connection.signal, isCurrent: () => !connection.signal.aborted },
    disconnect: () => connection.abort(),
  };
}

describe("browser operator control", () => {
  it("refuses other input while an operator holds control and resumes when they disconnect", async () => {
    // Refusal happens before any browser work, so an unreachable browser is enough here.
    const dispatcher = createDispatcher("http://127.0.0.1:9");
    const operator = operatorConnection("control-ui");
    // An unknown action kind fails validation right after admission, without browser work.
    const admittedInput = { kind: "not-an-action" };
    const notAdmitted = { status: 409, body: { error: PAUSED } };

    await expect(
      dispatcher.dispatch({ method: "POST", path: "/control", requester: operator.requester }),
    ).resolves.toEqual({
      status: 200,
      body: { available: true, controlled: true, byYou: true },
    });

    for (const [path, body] of [
      ["/act", { kind: "press", key: "Enter" }],
      ["/navigate", { url: "https://example.com" }],
      ["/tabs/open", { url: "https://example.com" }],
      ["/stop", {}],
    ] as const) {
      const refused = await dispatcher.dispatch({ method: "POST", path, body });
      expect(refused, path).toEqual(notAdmitted);
    }
    await expect(dispatcher.dispatch({ method: "GET", path: "/control" })).resolves.toEqual({
      status: 200,
      body: { available: false, controlled: true, byYou: false },
    });
    const own = await dispatcher.dispatch({
      method: "POST",
      path: "/act",
      body: admittedInput,
      requester: operator.requester,
    });
    expect(own.status).toBe(400);

    operator.disconnect();
    const resumed = await dispatcher.dispatch({
      method: "POST",
      path: "/act",
      body: admittedInput,
    });
    expect(resumed).not.toEqual(notAdmitted);
    expect(resumed.status).toBe(400);
    await expect(dispatcher.dispatch({ method: "GET", path: "/control" })).resolves.toEqual({
      status: 200,
      body: { available: false, controlled: false, byYou: false },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases control after five minutes without input from the operator", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("http://127.0.0.1:9");
    const operator = operatorConnection("control-ui");
    const status = async () =>
      (await dispatcher.dispatch({ method: "GET", path: "/control" })).body;
    await dispatcher.dispatch({ method: "POST", path: "/control", requester: operator.requester });

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    // Input the panel marks as deliberate restarts the idle window.
    await dispatcher.dispatch({
      method: "POST",
      path: "/act",
      query: { operatorInput: true },
      body: { kind: "not-an-action" },
      requester: operator.requester,
    });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await expect(status()).resolves.toMatchObject({ controlled: true });
    // Automatic panel requests (page-metrics reads, viewport fits) are not someone using the page.
    for (const kind of ["evaluate", "resize"]) {
      await dispatcher.dispatch({
        method: "POST",
        path: "/act",
        body: { kind },
        requester: operator.requester,
      });
    }

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(status()).resolves.toMatchObject({ controlled: false });
    const agent = await dispatcher.dispatch({
      method: "POST",
      path: "/act",
      body: { kind: "not-an-action" },
    });
    expect(agent.status).toBe(400);
  });

  it("holds the browser under every profile name that reaches it", async () => {
    const dispatcher = createDispatcher("http://127.0.0.1:9", "http://127.0.0.1:9");
    const operator = operatorConnection("control-ui");
    await dispatcher.dispatch({
      method: "POST",
      path: "/control",
      query: { profile: "fixture" },
      requester: operator.requester,
    });

    const viaAlias = await dispatcher.dispatch({
      method: "POST",
      path: "/act",
      query: { profile: "alias" },
      body: { kind: "press", key: "Enter" },
    });
    expect(viaAlias).toEqual({ status: 409, body: { error: PAUSED } });

    // A profile on a different browser is not held.
    const other = createDispatcher("http://127.0.0.1:9", "http://127.0.0.1:10");
    await other.dispatch({
      method: "POST",
      path: "/control",
      query: { profile: "fixture" },
      requester: operator.requester,
    });
    const elsewhere = await other.dispatch({
      method: "POST",
      path: "/act",
      query: { profile: "alias" },
      body: { kind: "not-an-action" },
    });
    expect(elsewhere.status).toBe(400);
  });

  it("only a Control UI connection can take control, and the status says which", async () => {
    const dispatcher = createDispatcher("http://127.0.0.1:9");
    const taken = await dispatcher.dispatch({ method: "POST", path: "/control" });
    expect(taken.status).toBe(400);
    // A node-routed panel request reaches the routes without a Control UI connection.
    await expect(dispatcher.dispatch({ method: "GET", path: "/control" })).resolves.toMatchObject({
      body: { available: false, controlled: false },
    });
    const operator = operatorConnection("control-ui");
    await expect(
      dispatcher.dispatch({ method: "GET", path: "/control", requester: operator.requester }),
    ).resolves.toMatchObject({ body: { available: true, controlled: false } });
  });
});
