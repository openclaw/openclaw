import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppMessageAction } from "./channel-react-action.js";

const delivery = vi.hoisted(() => ({
  react: vi.fn(async () => ({ content: [] })),
  send: vi.fn(async () => ({ messageId: "sent-1", toJid: "1555000:2@hosted" })),
}));

vi.mock("./channel-react-action.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-react-action.runtime.js")>()),
  handleWhatsAppAction: delivery.react,
  sendMessageWhatsApp: delivery.send,
}));

beforeEach(() => vi.clearAllMocks());

describe("WhatsApp context-inferred action targets", () => {
  it.each([
    ["react", "1555000:2@hosted"],
    ["upload-file", "1555000:2@hosted"],
  ] as const)("preserves the delivery JID for %s in %s", async (action, jid) => {
    await handleWhatsAppMessageAction({
      action,
      params: action === "react" ? { emoji: "👍" } : { filePath: "/tmp/document.pdf" },
      cfg: { channels: { whatsapp: { allowFrom: ["*"] } } },
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentChannelId: `whatsapp:${jid}`,
        currentMessageId: "current-1",
      },
    });
    if (action === "react") {
      expect(delivery.react).toHaveBeenCalledWith(
        expect.objectContaining({ chatJid: jid, messageId: "current-1" }),
        expect.anything(),
      );
    } else {
      expect(delivery.send).toHaveBeenCalledWith(jid, "", expect.anything());
    }
  });
});
