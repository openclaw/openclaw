import { randomBytes } from "node:crypto";
import { decryptPollVote, generateWAMessageContent, proto, type WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import {
  encryptWhatsAppPollVoteForTest,
  hashWhatsAppPollOptionForTest,
} from "../poll-vote.test-helper.js";
import {
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
} from "./durable-payload.js";
import { extractWhatsAppInboundPollRecord } from "./poll-creation-record.js";

const GROUP = "120363000000000001@g.us";
const CREATOR = "15550000003@s.whatsapp.net";
const CREATOR_LID = "11110000003@lid";

function inbound(message: proto.IMessage, key: Partial<WAMessage["key"]> = {}): WAMessage {
  return {
    key: { id: "POLL1", remoteJid: GROUP, participant: CREATOR, fromMe: false, ...key },
    message,
    pushName: "Dana",
  } as WAMessage;
}

const options = [{ optionName: "Pizza" }, { optionName: "Sushi" }];

describe("extractWhatsAppInboundPollRecord", () => {
  it("(a) recovers the exact secret through the real encoder, protobuf and the durable queue", async () => {
    const secret = randomBytes(32);
    const content = await generateWAMessageContent(
      {
        poll: {
          name: "Lunch?",
          values: ["Pizza", "Sushi"],
          selectableCount: 1,
          messageSecret: secret,
        },
      },
      {} as Parameters<typeof generateWAMessageContent>[1],
    );
    const decoded = proto.Message.decode(proto.Message.encode(content).finish());
    const replayed = deserializeWhatsAppDurableInboundMessage(
      serializeWhatsAppDurableInboundMessage(inbound(decoded)),
    );
    const record = extractWhatsAppInboundPollRecord(replayed);
    if (!record || "missingSecret" in record) {
      throw new Error("expected a poll record");
    }
    expect(Buffer.from(record.secret).equals(secret)).toBe(true);
    expect(record).toMatchObject({
      chatJids: [GROUP],
      creatorJids: [CREATOR],
      creatorName: "Dana",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    });

    // (b) a vote encrypted with that secret decrypts with Baileys' own decoder.
    const vote = encryptWhatsAppPollVoteForTest({
      secret: record.secret,
      pollMsgId: "POLL1",
      pollCreatorJid: CREATOR,
      voterJid: "15550000004@s.whatsapp.net",
      selectedOptions: ["Sushi"],
    });
    const decrypted = decryptPollVote(vote, {
      pollCreatorJid: CREATOR,
      pollMsgId: "POLL1",
      pollEncKey: record.secret,
      voterJid: "15550000004@s.whatsapp.net",
    });
    expect(decrypted.selectedOptions.map((hash) => Buffer.from(hash).toString("hex"))).toEqual([
      hashWhatsAppPollOptionForTest("Sushi").toString("hex"),
    ]);
  });

  it.each([
    ["V1", { pollCreationMessage: { name: "Q", options } }],
    ["V2", { pollCreationMessageV2: { name: "Q", options } }],
    ["V3", { pollCreationMessageV3: { name: "Q", options } }],
    ["V5", { pollCreationMessageV5: { name: "Q", options } }],
    [
      "V4 wrapped",
      { pollCreationMessageV4: { message: { pollCreationMessageV3: { name: "Q", options } } } },
    ],
    [
      "ephemeral",
      { ephemeralMessage: { message: { pollCreationMessage: { name: "Q", options } } } },
    ],
  ] as const)("(c) extracts %s polls", (_label, message) => {
    const secret = randomBytes(32);
    const record = extractWhatsAppInboundPollRecord(
      inbound({ ...(message as proto.IMessage), messageContextInfo: { messageSecret: secret } }),
    );
    expect(record).toMatchObject({ question: "Q", options: ["Pizza", "Sushi"] });
    expect(Buffer.from((record as { secret: Uint8Array }).secret).equals(secret)).toBe(true);
  });

  it("(d) falls back to the legacy encKey", () => {
    const encKey = randomBytes(32);
    const record = extractWhatsAppInboundPollRecord(
      inbound({ pollCreationMessage: { name: "Q", options, encKey } }),
    );
    expect(Buffer.from((record as { secret: Uint8Array }).secret).equals(encKey)).toBe(true);
  });

  it("(e) reports a missing or short secret", () => {
    expect(
      extractWhatsAppInboundPollRecord(inbound({ pollCreationMessageV3: { name: "Q", options } })),
    ).toEqual({ missingSecret: true });
    expect(
      extractWhatsAppInboundPollRecord(
        inbound({
          pollCreationMessageV3: { name: "Q", options },
          messageContextInfo: { messageSecret: randomBytes(16) },
        }),
      ),
    ).toEqual({ missingSecret: true });
  });

  it("(f) rejects 33 options or an option longer than 1024 bytes", () => {
    const secret = { messageContextInfo: { messageSecret: randomBytes(32) } };
    const many = Array.from({ length: 33 }, (_, index) => ({ optionName: `o${index}` }));
    expect(
      extractWhatsAppInboundPollRecord(
        inbound({ pollCreationMessage: { name: "Q", options: many }, ...secret }),
      ),
    ).toBeUndefined();
    expect(
      extractWhatsAppInboundPollRecord(
        inbound({
          pollCreationMessage: { name: "Q", options: [{ optionName: "x".repeat(1025) }] },
          ...secret,
        }),
      ),
    ).toBeUndefined();
    expect(
      extractWhatsAppInboundPollRecord(
        inbound({
          pollCreationMessage: {
            name: "Q",
            options: Array.from({ length: 32 }, (_, index) => ({ optionName: `o${index}` })),
          },
          ...secret,
        }),
      ),
    ).toMatchObject({ options: expect.arrayContaining(["o0", "o31"]) });
  });

  it("(g) records the creator in groups and direct chats and truncates a long question", () => {
    const secret = { messageContextInfo: { messageSecret: randomBytes(32) } };
    const group = extractWhatsAppInboundPollRecord(
      inbound({ pollCreationMessageV3: { name: "ש".repeat(600), options }, ...secret }, {
        participant: `${CREATOR.split("@")[0]}:7@s.whatsapp.net`,
        participantAlt: CREATOR_LID,
      } as Partial<WAMessage["key"]>),
    );
    expect(group).toMatchObject({
      chatJids: [GROUP],
      creatorJids: [CREATOR, CREATOR_LID],
      creatorName: "Dana",
      question: "ש".repeat(512),
    });
    const direct = extractWhatsAppInboundPollRecord(
      inbound({ pollCreationMessageV3: { name: "Q", options }, ...secret }, {
        remoteJid: CREATOR_LID,
        remoteJidAlt: CREATOR,
        participant: undefined,
      } as Partial<WAMessage["key"]>),
    );
    expect(direct).toMatchObject({
      chatJids: [CREATOR_LID, CREATOR],
      creatorJids: [CREATOR_LID, CREATOR],
    });
  });

  it("(h) ignores text messages", () => {
    expect(extractWhatsAppInboundPollRecord(inbound({ conversation: "hello" }))).toBeUndefined();
  });
});
