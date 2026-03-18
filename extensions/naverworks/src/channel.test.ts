import { describe, expect, it } from "vitest";
import { resolveAccount } from "./accounts.js";
import { createNaverWorksPlugin, resolveAutoThinkingDirective } from "./channel.js";

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

  it("resolves auto thinking directive from keyword rules", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            autoThinking: {
              enabled: true,
              defaultLevel: "medium",
              lowKeywords: ["요약"],
              highKeywords: ["분석", "비교"],
            },
          },
        },
      },
      "default",
    );

    expect(resolveAutoThinkingDirective({ text: "이 로그 좀 분석해줘", account })).toBe(
      "/think high",
    );
    expect(resolveAutoThinkingDirective({ text: "긴 문서를 요약해줘", account })).toBe(
      "/think low",
    );
    expect(resolveAutoThinkingDirective({ text: "안녕", account })).toBe("/think medium");
  });

  it("does not auto-inject when user already sent a think directive", () => {
    const account = resolveAccount(
      {
        channels: {
          naverworks: {
            autoThinking: {
              enabled: true,
              defaultLevel: "high",
            },
          },
        },
      },
      "default",
    );

    expect(
      resolveAutoThinkingDirective({ text: "/think low 그리고 답변해줘", account }),
    ).toBeUndefined();
  });
});
