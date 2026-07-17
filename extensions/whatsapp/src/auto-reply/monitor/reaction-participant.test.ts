// Whatsapp tests cover reaction participant identity resolution.
import { describe, expect, it } from "vitest";
import type { WhatsAppIdentity } from "../../identity.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { resolveReactionParticipant } from "./reaction-participant.js";

function createGroupMessage(sender: WhatsAppIdentity | undefined): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    platform: {
      chatJid: "120363000000000000@g.us",
      sender,
    },
    admission: {
      conversation: {
        kind: "group",
        id: "120363000000000000@g.us",
      },
      sender: {
        id: sender?.jid ?? sender?.lid ?? "unknown",
      },
    },
  });
}

describe("resolveReactionParticipant", () => {
  it("prefers the sender phone JID when both sender identities are available", () => {
    expect(
      resolveReactionParticipant(
        createGroupMessage({
          jid: "15551234567@s.whatsapp.net",
          lid: "277038292303944@lid",
        }),
      ),
    ).toBe("15551234567@s.whatsapp.net");
  });

  it("falls back to the sender LID when no sender phone JID is available", () => {
    expect(
      resolveReactionParticipant(
        createGroupMessage({
          jid: null,
          lid: "277038292303944@lid",
        }),
      ),
    ).toBe("277038292303944@lid");
  });

  it("omits the participant when the group sender identity is unavailable", () => {
    expect(resolveReactionParticipant(createGroupMessage(undefined))).toBeUndefined();
  });
});
