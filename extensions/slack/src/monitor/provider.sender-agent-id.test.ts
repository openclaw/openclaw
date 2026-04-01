import { describe, expect, it, vi } from "vitest";
import { buildSlackSenderAgentIdByUserId } from "./provider.js";

describe("buildSlackSenderAgentIdByUserId", () => {
  it("maps configured bot user ids to senderAgentId", async () => {
    const authTest = vi.fn(async ({ token }: { token?: string }) => {
      if (token === "xoxb-ops") {
        return { user_id: "U_OPS", bot_id: "B_OPS" };
      }
      throw new Error(`unexpected token ${token}`);
    });

    const ids = await buildSlackSenderAgentIdByUserId({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: { botToken: "xoxb-default" },
              ops: { botToken: "xoxb-ops" },
            },
          },
        },
        bindings: [
          {
            agentId: "default-agent",
            match: { channel: "slack", accountId: "default" },
          },
          {
            agentId: "ops-agent",
            match: { channel: "slack", accountId: "ops" },
          },
        ],
      } as never,
      client: { auth: { test: authTest } } as never,
      currentAccountId: "default",
      currentBotUserId: "U_DEFAULT",
      currentBotId: "B_DEFAULT",
    });

    expect(ids.get("U_DEFAULT")).toBe("default-agent");
    expect(ids.get("B_DEFAULT")).toBe("default-agent");
    expect(ids.get("U_OPS")).toBe("ops-agent");
    expect(ids.get("B_OPS")).toBe("ops-agent");
  });
});
