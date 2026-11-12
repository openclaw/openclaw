import "./browser-tool.test-support.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
import { BROWSER_OPERATOR_CONTROL_MESSAGE } from "./browser/operator-control.js";

const {
  browserClientMocks: client,
  browserActionsMocks: actions,
  resetBrowserToolMocks,
} = await import("./browser-tool.test-support.js");

beforeEach(resetBrowserToolMocks);
afterEach(resetBrowserToolMocks);

it.each([
  ["stop", { action: "stop", target: "host" }, client.browserStop],
  ["act", { action: "act", kind: "press", key: "Enter", target: "host" }, actions.browserAct],
] as const)("answers %s during a user takeover as a normal result", async (_name, args, mock) => {
  mock.mockRejectedValueOnce(new Error(BROWSER_OPERATOR_CONTROL_MESSAGE));

  const result = await createBrowserTool().execute("call-1", args);

  expect(result.details).toMatchObject({ status: "user_has_control" });
});
