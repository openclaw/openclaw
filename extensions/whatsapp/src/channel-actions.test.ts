import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

const { agentPrompt, actions } = whatsappPlugin;

function config(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]): OpenClawConfig {
  return { channels: { whatsapp: { allowFrom: ["*"], ...whatsapp } } };
}

describe("whatsapp public channel actions", () => {
  it("defaults to minimal reaction guidance when reactions are available", () => {
    const cfg = config({});
    expect(agentPrompt?.reactionGuidance?.({ cfg, accountId: "default" })?.level).toBe("minimal");
  });

  it("omits reaction guidance when WhatsApp is not configured", () => {
    expect(
      agentPrompt?.reactionGuidance?.({
        cfg: {},
        accountId: "default",
      }),
    ).toBeUndefined();
  });

  it("omits reaction guidance when WhatsApp reactions are disabled", () => {
    const cfg = config({ actions: { reactions: false } });
    expect(agentPrompt?.reactionGuidance?.({ cfg, accountId: "default" })).toBeUndefined();
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

    expect(agentPrompt?.reactionGuidance?.({ cfg, accountId: "default" })).toBeUndefined();
  });

  it("advertises react when agent reactions are enabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(actions?.describeMessageTool({ cfg, accountId: "default" })?.actions).toEqual([
      "react",
      "poll",
      "upload-file",
    ]);
  });

  it("returns null when WhatsApp is not configured", () => {
    expect(actions?.describeMessageTool({ cfg: {}, accountId: "default" })).toBeNull();
  });

  it("omits react when reactionLevel disables agent reactions", () => {
    const cfg = config({ reactionLevel: "ack" });
    expect(actions?.describeMessageTool({ cfg, accountId: "default" })?.actions).toEqual([
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

    expect(actions?.describeMessageTool({ cfg, accountId: "work" })?.actions).toEqual([
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
    expect(actions?.describeMessageTool({ cfg })?.actions).toEqual([
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
    expect(actions?.describeMessageTool({ cfg })?.actions).toEqual(["poll", "upload-file"]);
  });
});
