import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { vi } from "vitest";
import { createGoogleMeetToolGatewayForTest, setupGoogleMeetPlugin } from "./plugin-harness.js";

export function setupParticipationHarness(...args: Parameters<typeof setupGoogleMeetPlugin>) {
  const harness = setupGoogleMeetPlugin(...args);
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
    createGoogleMeetToolGatewayForTest(harness.methods),
  );
  const tool = harness.tools[0];
  if (!tool) {
    throw new Error("Expected Google Meet tool registration");
  }
  const execute = async (params: Record<string, unknown>) =>
    (await tool.execute("participation-call", params)).details;
  return { ...harness, execute };
}
