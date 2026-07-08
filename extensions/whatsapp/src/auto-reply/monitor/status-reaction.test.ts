// Whatsapp tests cover status reaction plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { createWhatsAppStatusReactionController } from "./status-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;

function createMessage(overrides: TestMsgOverrides = {}): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id: "msg-1" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543",
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "15551234567",
      },
      sender: {
        id: "15551234567",
      },
    },
    ...overrides,
  });
}

describe("createWhatsAppStatusReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the agent identity emoji when WhatsApp ackReaction has no emoji", async () => {
    const cfg = {
      agents: {
        list: [{ id: "agent", identity: { emoji: "🔥" } }],
      },
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
      },
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          ackReaction: {
            direct: true,
            group: "mentions",
          },
        },
      },
    } as OpenClawConfig;

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage(),
      agentId: "agent",
      sessionKey: "whatsapp:default:15551234567",
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        "🔥",
        {
          verbose: false,
          fromMe: false,
          accountId: "default",
          cfg,
        },
      );
    });
    await controller?.clear();
  });

  it("uses the active account reactionLevel override from admission", async () => {
    const cfg = {
      messages: {
        statusReactions: {
          enabled: true,
          timing: {
            debounceMs: 1_000_000,
            stallSoftMs: 1_000_000,
            stallHardMs: 1_000_000,
            doneHoldMs: 0,
            errorHoldMs: 0,
          },
        },
      },
      channels: {
        whatsapp: {
          reactionLevel: "off",
          ackReaction: {
            emoji: "👀",
            direct: true,
            group: "mentions",
          },
          accounts: {
            work: {
              reactionLevel: "ack",
            },
          },
        },
      },
    } as OpenClawConfig;

    const controller = await createWhatsAppStatusReactionController({
      cfg,
      msg: createMessage({
        admission: {
          accountId: "work",
        },
      }),
      agentId: "agent",
      sessionKey: "whatsapp:work:15551234567",
      verbose: false,
    });

    void controller?.setQueued();
    await vi.waitFor(() => {
      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          verbose: false,
          fromMe: false,
          accountId: "work",
          cfg,
        },
      );
    });
    await controller?.clear();
  });
});
