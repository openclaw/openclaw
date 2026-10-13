import type { AnyMessageContent, WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWhatsAppChatPollIds,
  readWhatsAppPollRecord,
  WHATSAPP_POLL_RECORD_STORES,
} from "../poll-vote-store.js";
import {
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "../poll-vote.test-helper.js";
import { createWebSendApi } from "./send-api.js";

const SELF_PN = "15550000001@s.whatsapp.net";
const SELF_LID = "11110000001@lid";
const GROUP = "120363000000000001@g.us";

let env: WhatsAppPollStateRuntimeForTest;
const sendMessage =
  vi.fn<(jid: string, content: AnyMessageContent) => Promise<WAMessage | undefined>>();

function createApi() {
  return createWebSendApi({
    sock: { sendMessage, sendPresenceUpdate: vi.fn(async () => {}) },
    defaultAccountId: "default",
    selfJids: () => [SELF_PN, SELF_LID],
  });
}

function sentSecret(): Buffer {
  const content = sendMessage.mock.calls[0]?.[1] as { poll?: { messageSecret?: Buffer } };
  const secret = content.poll?.messageSecret;
  if (!secret) {
    throw new Error("poll was sent without a secret");
  }
  return secret;
}

beforeEach(async () => {
  env = await installWhatsAppPollStateRuntimeForTest();
  sendMessage.mockReset();
  sendMessage.mockImplementation(
    async (jid) =>
      ({ key: { id: "POLL1", remoteJid: jid, fromMe: true, participant: SELF_PN } }) as WAMessage,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

describe("sendPoll records the sent poll", () => {
  it("stores the secret it sent, the question and chat index rows after acceptance", async () => {
    const result = await createApi().sendPoll(GROUP, {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
    });
    expect(result.messageId).toBe("POLL1");
    const record = await readWhatsAppPollRecord("default", "POLL1");
    expect(record).toMatchObject({
      origin: "sent",
      chatJids: [GROUP],
      creatorJids: [SELF_PN, SELF_LID],
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    });
    expect(Buffer.from(record?.secret ?? "", "base64").equals(sentSecret())).toBe(true);
    expect(
      await listWhatsAppChatPollIds({ accountId: "default", chatJids: [GROUP], limit: 3 }),
    ).toEqual([expect.objectContaining({ pollMessageId: "POLL1", origin: "sent" })]);
  });

  it("indexes both the requested and the returned chat JID", async () => {
    sendMessage.mockResolvedValueOnce({
      key: { id: "POLL2", remoteJid: "99990000002@lid", fromMe: true },
    } as WAMessage);
    await createApi().sendPoll("+15550000002", { question: "Q?", options: ["a", "b"] });
    expect((await readWhatsAppPollRecord("default", "POLL2"))?.chatJids).toEqual([
      "15550000002@s.whatsapp.net",
      "99990000002@lid",
    ]);
  });

  it("records nothing when the send is not accepted", async () => {
    sendMessage.mockRejectedValueOnce(new Error("socket closed"));
    await expect(
      createApi().sendPoll(GROUP, { question: "Q?", options: ["a", "b"] }),
    ).rejects.toThrow();
    sendMessage.mockResolvedValueOnce({ key: {} } as WAMessage);
    await expect(
      createApi().sendPoll(GROUP, { question: "Q?", options: ["a", "b"] }),
    ).rejects.toThrow();
    expect(await env.openStore(WHATSAPP_POLL_RECORD_STORES.sent).entries()).toEqual([]);
  });

  it.each(["PLUGIN_STATE_WRITE_FAILED", "PLUGIN_STATE_LIMIT_EXCEEDED"])(
    "keeps the send result when the store fails with %s, and logs no secret",
    async (code) => {
      env.faults.push({
        namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
        method: "register",
        code,
      });
      const result = await createApi().sendPoll(GROUP, { question: "Q?", options: ["a", "b"] });
      expect(result).toMatchObject({ messageId: "POLL1", providerAccepted: true });
      expect(env.logger.warn).toHaveBeenCalledTimes(1);
      expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll store record failed", { code });
      const logged = JSON.stringify([
        env.logger.warn.mock.calls,
        env.logger.info.mock.calls,
        env.logger.debug.mock.calls,
        env.logger.error.mock.calls,
      ]);
      expect(logged).not.toContain(sentSecret().toString("base64"));
      expect(logged).not.toContain(sentSecret().toString("hex"));
    },
  );
});
