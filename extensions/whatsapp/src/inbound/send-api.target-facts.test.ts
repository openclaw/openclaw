import type { WAMessage } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { createWebSendApi } from "./send-api.js";

function createApi() {
  const sendMessage = vi.fn<Parameters<typeof createWebSendApi>[0]["sock"]["sendMessage"]>(
    async () => ({ key: { id: "msg-1" } }) as WAMessage,
  );
  const api = createWebSendApi({
    sock: { sendMessage, sendPresenceUpdate: vi.fn(async () => {}) },
    defaultAccountId: "main",
  });
  return { api, sendMessage };
}

describe("WhatsApp reaction target facts", () => {
  it.each(["277038292303944:4@lid", "789@hosted.lid", "1555000:2@hosted"])(
    "accepts formed direct %s reaction chat JIDs",
    async (chatJid) => {
      const { api, sendMessage } = createApi();
      await api.sendReaction(chatJid, "msg-2", "👍", false);
      expect(sendMessage).toHaveBeenCalledWith(chatJid, {
        react: {
          text: "👍",
          key: { remoteJid: chatJid, id: "msg-2", fromMe: false, participant: undefined },
        },
      });
    },
  );

  it.each(["123@lid", "277038292303944:4@lid", "277038292303944:99@hosted.lid"])(
    "preserves %s participants in reaction keys",
    async (participant) => {
      const { api, sendMessage } = createApi();
      await api.sendReaction("12345@g.us", "msg-2", "👍", false, participant);
      expect(sendMessage).toHaveBeenCalledWith("12345@g.us", {
        react: {
          text: "👍",
          key: { remoteJid: "12345@g.us", id: "msg-2", fromMe: false, participant },
        },
      });
    },
  );
});
