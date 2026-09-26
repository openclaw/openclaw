import { qaChannelPlugin } from "@openclaw/qa-channel/api.js";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

it("uses a configured command owner for the approval fixture's resolver probe", async () => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  const cfg = buildQaGatewayConfig({
    bind: "loopback",
    gatewayPort: 18789,
    gatewayToken: "qa-test-token",
    workspaceDir: "/qa-workspace",
    transportPluginIds: ["qa-channel"],
  });
  const captured = new Error("resolver probe captured");
  let senderIsOwner: boolean | undefined;
  try {
    await expect(
      runLoadedScenarioFlow("approve-command-prototype-decision-usage", {
        onWaitForOutboundMessage: ({ waitCount, state }) => {
          if (waitCount === 1) {
            state.addOutboundMessage({
              accountId: "qa-channel",
              to: "dm:approve-prototype-dm",
              text: "Usage: /approve <id> <decision>",
            });
            return;
          }
          const input = state
            .getSnapshot()
            .messages.findLast((message) => message.direction === "inbound");
          expect(input?.text).toBe("/approve abc deny");
          senderIsOwner = resolveCommandAuthorization({
            cfg,
            ctx: {
              Provider: "qa-channel",
              Surface: "qa-channel",
              AccountId: "default",
              SenderId: input?.senderId,
              ChatType: "direct",
            },
            commandAuthorized: true,
          }).senderIsOwner;
          throw captured;
        },
      }),
    ).rejects.toBe(captured);
    expect(senderIsOwner).toBe(true);
  } finally {
    resetPluginRuntimeStateForTest();
  }
});
