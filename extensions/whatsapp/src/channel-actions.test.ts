import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeWhatsAppMessageActions,
  resolveWhatsAppAgentReactionExtraGuidance,
  resolveWhatsAppAgentReactionGuidance,
} from "./channel-actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  listWhatsAppAccountIds: vi.fn((cfg: OpenClawConfig) => {
    const accountIds = Object.keys(cfg.channels?.whatsapp?.accounts ?? {});
    return accountIds.length > 0 ? accountIds : ["default"];
  }),
  resolveWhatsAppAccount: vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => ({
      enabled:
        accountId == null ? true : cfg.channels?.whatsapp?.accounts?.[accountId]?.enabled !== false,
    }),
  ),
}));

vi.mock("./channel-actions.runtime.js", async () => {
  return {
    listWhatsAppAccountIds: hoisted.listWhatsAppAccountIds,
    resolveWhatsAppAccount: hoisted.resolveWhatsAppAccount,
    createActionGate: (actions?: { reactions?: boolean; polls?: boolean }) => (name: string) => {
      if (name === "reactions") {
        return actions?.reactions !== false;
      }
      if (name === "polls") {
        return actions?.polls !== false;
      }
      return true;
    },
    resolveWhatsAppReactionLevel: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string;
    }) => {
      const accountLevel =
        accountId == null
          ? undefined
          : cfg.channels?.whatsapp?.accounts?.[accountId]?.reactionLevel;
      const level = accountLevel ?? cfg.channels?.whatsapp?.reactionLevel ?? "minimal";
      return {
        level,
        agentReactionsEnabled: level === "minimal" || level === "extensive",
        agentReactionGuidance: level === "minimal" || level === "extensive" ? level : undefined,
      };
    },
  };
});

describe("whatsapp channel action helpers", () => {
  beforeEach(() => {
    hoisted.listWhatsAppAccountIds.mockClear();
    hoisted.resolveWhatsAppAccount.mockClear();
  });

  it("defaults to minimal reaction guidance when reactions are available", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBe("minimal");
  });

  it("omits reaction guidance when WhatsApp is not configured", () => {
    expect(
      resolveWhatsAppAgentReactionGuidance({
        cfg: {} as OpenClawConfig,
        accountId: "default",
      }),
    ).toBeUndefined();
  });

  it("returns minimal reaction guidance when configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "minimal",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBe("minimal");
  });

  it("adds configured emoji policy to reaction extra guidance", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "extensive",
          allowFrom: ["*"],
          allowedReactions: ["👨🏻‍💻", "💯"],
          workIntakeReaction: {
            emoji: "👨🏻‍💻",
          },
        },
      },
    } as OpenClawConfig;

    const level = resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" });
    const guidance = resolveWhatsAppAgentReactionExtraGuidance({ cfg, accountId: "default" });

    expect(level).toBe("extensive");
    expect(guidance.join("\n")).toContain("Allowed WhatsApp selected emojis: 👨🏻‍💻 💯");
    expect(guidance.join("\n")).toContain("default acknowledgment reaction is 👨🏻‍💻");
    expect(guidance.join("\n")).toContain("Reactions are available in every WhatsApp session");
    expect(guidance.join("\n")).toContain("Do not react to every owner message");
    expect(guidance.join("\n")).toContain("an emoji can also be the entire text reply");
    expect(guidance.join("\n")).toContain(
      "pass participant from trusted conversation info sender_id",
    );
    expect(guidance.join("\n")).toContain("WhatsApp Emotion Pulse");
    expect(guidance.join("\n")).toContain("emoji_burst is 5-7 selected emojis with no text");
    expect(guidance.join("\n")).toContain("Brodie-finesse lesson");
  });

  it("always emits the cross-session reaction reminder when WhatsApp is configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const guidance = resolveWhatsAppAgentReactionExtraGuidance({ cfg, accountId: "default" });
    expect(guidance.join("\n")).toContain("Reactions are available in every WhatsApp session");
  });

  it("emits no guidance strings when WhatsApp is not configured", () => {
    const guidance = resolveWhatsAppAgentReactionExtraGuidance({
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    expect(guidance).toEqual([]);
  });

  it("omits reaction guidance when WhatsApp reactions are disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: false },
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBeUndefined();
  });

  it("omits reaction guidance when reactionLevel disables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBeUndefined();
  });

  it("advertises react when agent reactions are enabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(describeWhatsAppMessageActions({ cfg, accountId: "default" })?.actions).toEqual([
      "react",
      "poll",
    ]);
  });

  it("returns null when WhatsApp is not configured", () => {
    expect(
      describeWhatsAppMessageActions({ cfg: {} as OpenClawConfig, accountId: "default" }),
    ).toBeNull();
  });

  it("omits react when reactionLevel disables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(describeWhatsAppMessageActions({ cfg, accountId: "default" })?.actions).toEqual([
      "poll",
    ]);
  });

  it("uses the active account reactionLevel for discovery", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(describeWhatsAppMessageActions({ cfg, accountId: "work" })?.actions).toEqual([
      "react",
      "poll",
    ]);
  });

  it("keeps react in global discovery when any account enables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.listWhatsAppAccountIds.mockReturnValue(["default", "work"]);

    expect(describeWhatsAppMessageActions({ cfg })?.actions).toEqual(["react", "poll"]);
  });

  it("omits react in global discovery when only disabled accounts enable agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              enabled: false,
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.listWhatsAppAccountIds.mockReturnValue(["default", "work"]);

    expect(describeWhatsAppMessageActions({ cfg })?.actions).toEqual(["poll"]);
  });
});
