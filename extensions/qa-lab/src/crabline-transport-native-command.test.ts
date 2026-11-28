import { describe, expect, it } from "vitest";
import { withTransport } from "./crabline-transport.test-support.js";

const NATIVE_COMMAND_CASES = [
  { command: "stop", name: "stop" },
  { command: "queue collect please help", name: "queue" },
  { command: "think high", name: "think" },
] as const;

describe("Crabline Telegram native command arguments", () => {
  it("preserves full command text while restricting native names and entities to the command token", async () => {
    await withTransport("telegram", async (transport) => {
      for (const { command } of NATIVE_COMMAND_CASES) {
        await transport.sendNativeCommand?.({
          command,
          conversation: { id: "alice", kind: "direct" },
          senderId: "alice",
          senderName: "Alice",
        });
      }

      expect(transport.state.getSnapshot().messages).toMatchObject(
        NATIVE_COMMAND_CASES.map(({ command, name }) => ({
          text: `/${command}`,
          nativeCommand: { name },
        })),
      );

      const telegram = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" }).channels
        ?.telegram as { apiRoot?: string; botToken?: string } | undefined;
      if (!telegram?.apiRoot || !telegram.botToken) {
        throw new Error("Crabline Telegram API root and bot token are required");
      }
      const response = await fetch(`${telegram.apiRoot}/bot${telegram.botToken}/getUpdates`);
      await expect(response.json()).resolves.toMatchObject({
        result: NATIVE_COMMAND_CASES.map(({ command, name }) => ({
          message: {
            entities: [{ length: name.length + 1, offset: 0, type: "bot_command" }],
            text: `/${command}`,
          },
        })),
      });
    });
  });
});
