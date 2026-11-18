import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

const { agentPrompt, actions } = whatsappPlugin;

function config(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]): OpenClawConfig {
  return { channels: { whatsapp: { allowFrom: ["*"], ...whatsapp } } };
}

describe("whatsapp public channel actions", () => {
  it.each([
    ["default", config({}), "minimal"],
    ["unconfigured", {}, undefined],
    ["disabled actions", config({ actions: { reactions: false } }), undefined],
    ["ack only", config({ reactionLevel: "ack" }), undefined],
  ] as const)("reaction guidance: %s", (_name, cfg, level) => {
    const guidance = agentPrompt?.reactionGuidance?.({ cfg, accountId: "default" });
    if (level === undefined) {
      expect(guidance).toBeUndefined();
    } else {
      expect(guidance?.level).toBe(level);
    }
  });

  const withReactions = ["react", "poll", "upload-file"];
  const withoutReactions = ["poll", "upload-file"];
  const namedAccount = config({
    reactionLevel: "ack",
    accounts: { work: { reactionLevel: "minimal" } },
  });
  it.each([
    ["default", config({}), "default", withReactions],
    ["unconfigured", {}, "default", null],
    ["ack only", config({ reactionLevel: "ack" }), "default", withoutReactions],
    ["active account", namedAccount, "work", withReactions],
    ["any enabled account", namedAccount, undefined, withReactions],
    [
      "disabled account",
      config({
        reactionLevel: "ack",
        accounts: { work: { enabled: false, reactionLevel: "minimal" } },
      }),
      undefined,
      withoutReactions,
    ],
  ] as const)("action discovery: %s", (_name, cfg, accountId, expected) => {
    const result = actions?.describeMessageTool({ cfg, accountId });
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result?.actions).toEqual(expected);
    }
  });
});
