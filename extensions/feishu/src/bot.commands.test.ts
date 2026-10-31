import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-detection";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";
import { createFeishuTestConfig, createFeishuTestEvent } from "./bot.test-support.js";

describe("Feishu text command admission", () => {
  const { handleFeishuMessage, resolvedTurnCalls, runtimeStub } = setupFeishuBroadcastTestHarness();

  it.each(["/status", "/btw progress?", "/followup next task", "/steer correction"])(
    "classifies DM %s before dispatch without changing agent mention context",
    async (command) => {
      vi.spyOn(runtimeStub.channel.commands, "shouldComputeCommandAuthorized").mockImplementation(
        shouldComputeCommandAuthorized,
      );
      await handleFeishuMessage({
        cfg: createFeishuTestConfig({ dmPolicy: "open", allowFrom: ["*"] }),
        event: createFeishuTestEvent({
          messageId: `msg-dm-mention-${command}`,
          text: `@_bot ${command}`,
          message: { mentions: [{ key: "@_bot", id: { open_id: "ou-bot" }, name: "Bot" }] },
        }),
        botOpenId: "ou-bot",
        runtime: createRuntimeEnv(),
      });
      expect(resolvedTurnCalls).toHaveLength(1);
      const context = resolvedTurnCalls[0]?.ctxPayload;
      expect(context).toMatchObject({
        RawBody: `<at user_id="ou-bot">Bot</at> ${command}`,
        CommandBody: command,
        BodyForCommands: command,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          body: command,
        },
      });
      expect(context?.BodyForAgent).toContain(`<at user_id="ou-bot">Bot</at> ${command}`);
    },
  );
});
