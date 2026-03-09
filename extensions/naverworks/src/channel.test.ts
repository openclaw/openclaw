import { describe, expect, it } from "vitest";
import { resolveAccount } from "./accounts.js";
import { createNaverWorksPlugin } from "./channel.js";

describe("naverworks channel plugin", () => {
  it("marks account configured when botId + auth are present", async () => {
    const plugin = createNaverWorksPlugin();
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            botId: "bot-1",
            accessToken: "token-1",
          },
        },
      },
      "default",
    );

    expect(plugin.config.isConfigured?.(account as never, {} as never)).toBe(true);
  });

  it("marks account unconfigured when outbound auth is missing", async () => {
    const plugin = createNaverWorksPlugin();
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            botId: "bot-1",
          },
        },
      },
      "default",
    );

    expect(plugin.config.isConfigured?.(account as never, {} as never)).toBe(false);
  });

  it("reports not-configured from outbound sendText", async () => {
    const plugin = createNaverWorksPlugin();
    if (!plugin.outbound?.sendText) {
      throw new Error("outbound.sendText missing");
    }

    await expect(
      plugin.outbound.sendText({
        cfg: { channels: { naverworks: {} } } as never,
        to: "user-1",
        text: "hello",
      }),
    ).rejects.toThrow(/not configured for outbound delivery/i);
  });
});
