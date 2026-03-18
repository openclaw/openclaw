import { describe, expect, it } from "vitest";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";

describe("telegram group policy", () => {
  it("resolves topic-level requireMention and chat-level tools for topic ids", () => {
    const telegramCfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              tools: { allow: ["message.send"] },
              topics: {
                "77": {
                  requireMention: false,
                },
              },
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    expect(
      resolveTelegramGroupRequireMention({ cfg: telegramCfg, groupId: "-1001:topic:77" }),
    ).toBe(false);
    expect(resolveTelegramGroupToolPolicy({ cfg: telegramCfg, groupId: "-1001:topic:77" })).toEqual(
      {
        allow: ["message.send"],
      },
    );
  });
});
