import "./browser-tool.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
import {
  BROWSER_OPERATOR_CONTROL_MESSAGE,
  recordBrowserOperatorInput,
  takeBrowserOperatorControl,
} from "./browser/operator-control.js";
import type { BrowserServerState } from "./browser/server-context.types.js";

let browserState: BrowserServerState | null = null;
vi.mock("./browser-control-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-control-state.js")>()),
  getBrowserControlState: () => browserState,
}));

const {
  browserClientMocks: client,
  browserActionsMocks: actions,
  resetBrowserToolMocks,
} = await import("./browser-tool.test-support.js");

beforeEach(resetBrowserToolMocks);
afterEach(() => {
  resetBrowserToolMocks();
  browserState = null;
});

/** The running host browser the agent's results are checked against. */
async function hostBrowser() {
  const config = await vi.importActual<typeof import("./browser/config.js")>("./browser/config.js");
  const state: BrowserServerState = {
    port: 0,
    resolved: config.resolveBrowserConfig({
      defaultProfile: "openclaw",
      profiles: { openclaw: { cdpUrl: "http://127.0.0.1:18792", color: "#FF4500" } },
    }),
    profiles: new Map(),
  };
  browserState = state;
  return { state, profile: config.resolveProfile(state.resolved, "openclaw")! };
}

it.each([
  ["stop", { action: "stop", target: "host" }, client.browserStop],
  ["act", { action: "act", kind: "press", key: "Enter", target: "host" }, actions.browserAct],
] as const)("answers %s during a user takeover as a normal result", async (_name, args, mock) => {
  mock.mockRejectedValueOnce(new Error(BROWSER_OPERATOR_CONTROL_MESSAGE));

  const result = await createBrowserTool().execute("call-1", args);

  expect(result.details).toMatchObject({ status: "user_has_control" });
});

it("adds no note after Browser panel input without a takeover", async () => {
  const { state, profile } = await hostBrowser();
  recordBrowserOperatorInput(state, profile, "panel-1");

  const result = await createBrowserTool().execute("call-1", {
    action: "act",
    kind: "press",
    key: "Enter",
    target: "host",
  });

  expect(JSON.stringify(result.content)).not.toContain("Browser panel");
});

it("notes a takeover on results the agent can still get", async () => {
  const { state, profile } = await hostBrowser();
  const controller = new AbortController();
  takeBrowserOperatorControl(state, profile, {
    connId: "panel-1",
    signal: controller.signal,
    isCurrent: () => true,
  });

  try {
    const result = await createBrowserTool().execute("call-1", {
      action: "snapshot",
      target: "host",
    });

    expect(result.content.at(-1)).toEqual({
      type: "text",
      text: "Note: the user has taken over this browser in the Browser panel. You can look, but actions wait until they release control.",
    });
  } finally {
    controller.abort();
  }
});
