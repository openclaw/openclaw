import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  describeWhatsAppMessageActions,
  resolveWhatsAppAgentReactionGuidance,
} from "./channel-actions.js";

function config(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]): OpenClawConfig {
  return { channels: { whatsapp: { allowFrom: ["*"], ...whatsapp } } };
}

describe("whatsapp channel action helpers", () => {
  it("defaults to minimal reaction guidance when reactions are available", () => {
    const cfg = config({});
    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBe("minimal");
  });

  it("omits reaction guidance when WhatsApp is not configured", () => {
    expect(
      resolveWhatsAppAgentReactionGuidance({
        cfg: {},
        accountId: "default",
      }),
    ).toBeUndefined();
  });

  it("omits reaction guidance when WhatsApp reactions are disabled", () => {
    const cfg = config({ actions: { reactions: false } });
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
      "upload-file",
    ]);
  });

  it("returns null when WhatsApp is not configured", () => {
    expect(describeWhatsAppMessageActions({ cfg: {}, accountId: "default" })).toBeNull();
  });

  it("omits react when reactionLevel disables agent reactions", () => {
    const cfg = config({ reactionLevel: "ack" });
    expect(describeWhatsAppMessageActions({ cfg, accountId: "default" })?.actions).toEqual([
      "poll",
      "upload-file",
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
      "upload-file",
    ]);
  });

  it("keeps react in global discovery when any account enables agent reactions", () => {
    const cfg = config({
      reactionLevel: "ack",
      accounts: { work: { reactionLevel: "minimal" } },
    });
    expect(describeWhatsAppMessageActions({ cfg })?.actions).toEqual([
      "react",
      "poll",
      "upload-file",
    ]);
  });

  it("omits react in global discovery when only disabled accounts enable agent reactions", () => {
    const cfg = config({
      reactionLevel: "ack",
      accounts: { work: { enabled: false, reactionLevel: "minimal" } },
    });
    expect(describeWhatsAppMessageActions({ cfg })?.actions).toEqual(["poll", "upload-file"]);
  });
});
