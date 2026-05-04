import { describe, expect, it } from "vitest";
import { classifyWhatsAppGroupAddressee } from "./group-addressee.js";

const SELF_JID = "919152233366@s.whatsapp.net";
const SELF_LID = "57711827927237@lid";
const BRODIE_LID = "2710527070277@lid";
const GROUP_ID = "120363406331109499@g.us";

function makeConfig(agentName = "shoar") {
  return {
    agents: {
      list: [{ id: "main", name: agentName }],
    },
    channels: {
      whatsapp: {
        allowFrom: ["+919022233366"],
        groupPolicy: "open",
        groups: {
          "*": { requireMention: true },
        },
      },
    },
  } as never;
}

function makeGroupMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    from: GROUP_ID,
    conversationId: GROUP_ID,
    accountId: "default",
    chatId: GROUP_ID,
    chatType: "group",
    groupSubject: "bot-bros",
    body: "hello",
    to: "+919152233366",
    sender: {
      jid: "817090966969@s.whatsapp.net",
      e164: "+817090966969",
      name: "Abhay",
    },
    senderJid: "817090966969@s.whatsapp.net",
    senderE164: "+817090966969",
    senderName: "Abhay",
    self: {
      jid: SELF_JID,
      lid: SELF_LID,
      e164: "+919152233366",
    },
    selfJid: SELF_JID,
    selfLid: SELF_LID,
    selfE164: "+919152233366",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  } as never;
}

function decide(
  overrides: {
    msg?: Record<string, unknown>;
    activation?: "always" | "mention" | "never";
    wasMentioned?: boolean;
    agentName?: string;
    groupMemberNames?: Map<string, string>;
    groupHistory?: Array<{
      sender?: string;
      body?: string;
      timestamp?: number;
      senderJid?: string;
    }>;
    nowMs?: number;
  } = {},
) {
  return classifyWhatsAppGroupAddressee({
    cfg: makeConfig(overrides.agentName),
    msg: makeGroupMessage(overrides.msg),
    agentId: "main",
    activation: overrides.activation ?? "mention",
    wasMentioned: overrides.wasMentioned,
    groupMemberNames: overrides.groupMemberNames,
    groupHistory: overrides.groupHistory,
    nowMs: overrides.nowMs,
  });
}

describe("classifyWhatsAppGroupAddressee", () => {
  it("suppresses Abhay tasking Brodie without a shoar mention", () => {
    const result = decide({ msg: { body: "Brodie summarize this" } });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
    expect(result.reason).toBe("explicit_other_agent_address");
  });

  it("suppresses lower-case brodie tasks from any sender", () => {
    const result = decide({
      msg: {
        body: "brodie do this",
        senderName: "Kavish",
        senderE164: "+919022233366",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
  });

  it("allows configured self-name tasks", () => {
    const result = decide({ msg: { body: "@shoar do this" } });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
  });

  it("allows spaced self-name address", () => {
    const result = decide({ msg: { body: "s h o a r, can you respond to this?" } });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
    expect(result.reason).toBe("explicit_self_address");
  });

  it("allows obvious self-name typos without opening generic bot chatter", () => {
    const selfTypo = decide({ msg: { body: "shaor, can you respond to this?" } });
    const genericBot = decide({ msg: { body: "bot can you respond to this?" } });

    expect(selfTypo.allowReply).toBe(true);
    expect(selfTypo.state).toBe("direct_task_to_self");
    expect(genericBot.allowReply).toBe(false);
  });

  it("allows social self aliases like Kavish's Agent", () => {
    const result = decide({
      msg: { body: "hey Kavish's Agent say boogie" },
      groupMemberNames: new Map([["+919022233366", "Kavish Agarwal"]]),
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
  });

  it("allows owner indexicals like my agent", () => {
    const result = decide({
      msg: {
        body: "hello my agent\nis this true?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("addressed_to_self");
  });

  it("allows inline replies to shoar", () => {
    const result = decide({
      msg: {
        body: "do this",
        replyToId: "prev-self",
        replyToBody: "earlier shoar reply",
        replyToSenderJid: SELF_JID,
        replyToSenderE164: "+919152233366",
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
    expect(result.reason).toBe("reply_to_self");
  });

  it("suppresses inline replies to Brodie unless shoar is named", () => {
    const result = decide({
      msg: {
        body: "do this",
        replyToId: "prev-brodie",
        replyToBody: "brodie reply",
        replyToSender: "brodie",
        replyToSenderJid: BRODIE_LID,
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
    expect(result.reason).toBe("reply_to_other_agent");
  });

  it("suppresses Kavish asking Brodie through Abhay", () => {
    const result = decide({
      msg: {
        body: "ask brodie to check this",
        senderName: "Kavish",
        senderE164: "+919022233366",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
  });

  it("allows a self pivot even when Brodie is mentioned", () => {
    const result = decide({ msg: { body: "shoar, check what Brodie said" } });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
  });

  it("allows owner multi-agent tags when shoar is included", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "shoar and brodie can you simplify this?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
    expect(result.reason).toBe("explicit_self_address");
  });

  it("suppresses ambient room messages unless activation is always", () => {
    const normalRoom = { body: "this is insane", groupSubject: "family group" };

    expect(decide({ msg: normalRoom, activation: "mention" }).allowReply).toBe(false);
    expect(decide({ msg: normalRoom, activation: "always" }).allowReply).toBe(true);
  });

  it("lets always-on activation send owner ambient multi-agent turns to the model", () => {
    const result = decide({
      msg: {
        body: "this is insane",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
      activation: "always",
    });

    expect(result.allowReply).toBe(true);
    expect(result.reason).toBe("ambient_allowed_by_group_activation");
    expect(result.confidence).toBe("low");
    expect(result.debug.senderIsOwner).toBe(true);
  });

  it("suppresses non-owner ambient multi-agent turns even when bot-bros is always-on", () => {
    const result = decide({ msg: { body: "nevermind i am way off lmao" }, activation: "always" });

    expect(result.allowReply).toBe(false);
    expect(result.reason).toBe("ambient_non_owner_multi_agent_without_self_address");
  });

  it("lets owner context continuations reach Shoar as low-confidence model judgment", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "it downloaded that and installed the CLI for the same",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("owner_context_continuation_for_model_judgment");
    expect(result.confidence).toBe("low");
    expect(result.debug.ownerContextContinuation).toBe(true);
  });

  it("lets owner bare-you questions reach Shoar as low-confidence model judgment", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "you still pay for claude max?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("second_person_owner_for_model_judgment");
    expect(result.confidence).toBe("low");
    expect(result.debug.secondPersonAddress).toBe(true);
  });

  it("treats owner silence and typing complaints as a Shoar behavior pull", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "why did you disappear after typing?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("addressed_to_self");
    expect(result.reason).toBe("owner_shoar_behavior_pull");
    expect(result.confidence).toBe("medium");
    expect(result.debug.ownerShoarBehaviorPull).toBe(true);
  });

  it("treats owner ambient-noise complaints as a Shoar behavior pull", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "how is this ambient noise when i'm literally talking to you?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("addressed_to_self");
    expect(result.reason).toBe("owner_shoar_behavior_pull");
    expect(result.debug.ownerShoarBehaviorPull).toBe(true);
  });

  it("treats owner no_reply grievances naming shoar as a Shoar behavior pull", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "i spent 2 hours on shoar's no_reply last night and shoar does not hold convos with me here anymore",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("addressed_to_self");
    expect(result.reason).toBe("owner_shoar_behavior_pull");
    expect(result.debug.ownerShoarBehaviorPull).toBe(true);
  });

  it("treats owner inline reply visibility complaints as a Shoar behavior pull", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "classic, the inline thing isnt working either",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("addressed_to_self");
    expect(result.reason).toBe("owner_shoar_behavior_pull");
    expect(result.debug.ownerShoarBehaviorPull).toBe(true);
  });

  it("lets owner multi-agent simplification complaints reach model judgment", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "why did nobody simplify it?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("owner_multi_agent_pull_for_model_judgment");
    expect(result.confidence).toBe("medium");
    expect(result.debug.ownerMultiAgentPull).toBe(true);
  });

  it("keeps owner behavior complaints to another named person silence-biased", () => {
    const result = decide({
      activation: "always",
      groupMemberNames: new Map([["+817090966969", "Abhay"]]),
      msg: {
        body: "Abhay why did you disappear after typing?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("addressed_to_other_person");
    expect(result.reason).toBe("explicit_other_person_address");
  });

  it("still allows non-owner messages that explicitly task shoar", () => {
    const result = decide({
      activation: "always",
      msg: { body: "shoar check the git blame" },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
  });

  it("lets owner fragments reach Shoar as low-confidence model judgment", () => {
    const nowMs = 1_800_000_000_000;
    const result = decide({
      activation: "always",
      nowMs,
      groupHistory: [
        {
          sender: "Abhay (+817090966969)",
          body: "brodie reacts.. shoar responds.. that is the difference",
          timestamp: nowMs - 30_000,
          senderJid: "817090966969@s.whatsapp.net",
        },
      ],
      msg: {
        body: "a lot of it is also opus bhai",
        timestamp: nowMs,
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("owner_fragment_continuation_for_model_judgment");
    expect(result.confidence).toBe("low");
    expect(result.debug.ownerFragmentContinuation).toBe(true);
    expect(result.debug.recentOtherParticipantContext).toBe(true);
  });

  it("lets later owner fragments reach Shoar as low-confidence model judgment", () => {
    const nowMs = 1_800_000_000_000;
    const result = decide({
      activation: "always",
      nowMs,
      groupHistory: [
        {
          sender: "Kavish (+919022233366)",
          body: "a lot of it is also opus bhai",
          timestamp: nowMs - 20_000,
          senderJid: "919022233366@s.whatsapp.net",
        },
      ],
      msg: {
        body: "the whole response is vibes this vibes that",
        timestamp: nowMs,
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("owner_fragment_continuation_for_model_judgment");
    expect(result.confidence).toBe("low");
    expect(result.debug.recentOwnerAmbientFragments).toBe(1);
  });

  it("still lets owner explicit shoar pivots break out of fragment patience", () => {
    const nowMs = 1_800_000_000_000;
    const result = decide({
      activation: "always",
      nowMs,
      groupHistory: [
        {
          sender: "Abhay (+817090966969)",
          body: "brodie reacts.. shoar responds.. that is the difference",
          timestamp: nowMs - 30_000,
          senderJid: "817090966969@s.whatsapp.net",
        },
      ],
      msg: {
        body: "shoar, give me the shortest possible take on this",
        timestamp: nowMs,
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
    expect(result.reason).toBe("explicit_self_address");
  });

  it("suppresses ambient messages from another bot", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "I checked it",
        sender: {
          jid: "817090966969@s.whatsapp.net",
          e164: "+817090966969",
          name: "Brodie",
        },
        senderName: "Brodie",
        senderE164: "+817090966969",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.reason).toBe("sender_is_other_agent");
  });

  it("suppresses other-agent completion updates that only mention shoar incidentally", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "done. added it under lessons learned: shoar's note about timing is now captured.",
        sender: {
          jid: BRODIE_LID,
          name: "brodie",
        },
        senderJid: BRODIE_LID,
        senderName: "brodie",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.reason).toBe("sender_is_other_agent");
    expect(result.debug.incidentalSelfReference).toBe(true);
  });

  it("still allows another bot to explicitly pivot to shoar", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "shoar, can you check my patch?",
        sender: {
          jid: BRODIE_LID,
          name: "brodie",
        },
        senderJid: BRODIE_LID,
        senderName: "brodie",
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
  });

  it("lets other-agent targeting beat always-on activation", () => {
    const result = decide({
      activation: "always",
      msg: { body: "Brodie summarize this" },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
  });

  it("does not suppress direct DMs just because Brodie is mentioned", () => {
    const result = classifyWhatsAppGroupAddressee({
      cfg: makeConfig(),
      msg: makeGroupMessage({
        from: "+919022233366",
        conversationId: "+919022233366",
        chatId: "+919022233366",
        chatType: "direct",
        body: "ask Brodie to check this",
      }),
      agentId: "main",
      activation: "mention",
    });

    expect(result.allowReply).toBe(true);
    expect(result.reason).toBe("direct_dm");
  });

  it("allows self JID and LID mentions", () => {
    expect(decide({ msg: { body: "do this", mentionedJids: [SELF_JID] } }).allowReply).toBe(true);
    expect(decide({ msg: { body: `@${SELF_LID.split("@")[0]} do this` } }).allowReply).toBe(true);
  });

  it("requires configured name aliases for body-only self names", () => {
    expect(decide({ msg: { body: "shoar do this" }, agentName: "shoar" }).allowReply).toBe(true);
    expect(decide({ msg: { body: "shoar do this" }, agentName: "openclaw" }).allowReply).toBe(
      false,
    );
  });

  it("suppresses mentions of a different JID unless self is also mentioned", () => {
    expect(
      decide({
        msg: { body: "@someone do this", mentionedJids: ["111@s.whatsapp.net"] },
        activation: "always",
        wasMentioned: true,
      }).allowReply,
    ).toBe(false);
    expect(
      decide({
        msg: { body: "@someone @shoar do this", mentionedJids: ["111@s.whatsapp.net", SELF_JID] },
        activation: "always",
      }).allowReply,
    ).toBe(true);
  });

  it("suppresses quote targets that are someone else", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "sounds good",
        replyToId: "other",
        replyToBody: "someone else's message",
        replyToSender: "Abhay",
        replyToSenderJid: "817090966969@s.whatsapp.net",
        replyToSenderE164: "+817090966969",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("addressed_to_other_person");
  });

  it("lets owner self-replies reach the model for social judgment in always-on groups", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "say this again",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
        replyToId: "owner-prev",
        replyToBody: "m y a g e n t s a y helluuuu",
        replyToSender: "Kavish",
        replyToSenderJid: "203873608286239@lid",
        replyToSenderE164: "+919022233366",
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("owner_self_reply_for_model_judgment");
    expect(result.debug.ownerSelfReply).toBe(true);
  });

  it("lets owner self-replies with bare-you questions reach model judgment", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "did u see this message?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
        replyToId: "owner-prev",
        replyToBody: "do u know what this says",
        replyToSender: "Kavish",
        replyToSenderJid: "203873608286239@lid",
        replyToSenderE164: "+919022233366",
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reason).toBe("owner_self_reply_for_model_judgment");
    expect(result.debug.ownerSelfReply).toBe(true);
    expect(result.debug.secondPersonAddress).toBe(true);
  });

  it("still suppresses owner self-replies that explicitly address another person", () => {
    const result = decide({
      activation: "always",
      groupMemberNames: new Map([["+817090966969", "Abhay"]]),
      msg: {
        body: "Abhay you still pay for claude max?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
        replyToId: "owner-prev",
        replyToBody: "previous owner message",
        replyToSender: "Kavish",
        replyToSenderJid: "919022233366@s.whatsapp.net",
        replyToSenderE164: "+919022233366",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("addressed_to_other_person");
    expect(result.reason).toBe("explicit_other_person_address");
    expect(result.debug.ownerSelfReply).toBe(true);
  });

  it("still suppresses owner self-replies that explicitly task another bot", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "brodie say this again",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
        replyToId: "owner-prev",
        replyToBody: "previous owner message",
        replyToSender: "Kavish",
        replyToSenderJid: "919022233366@s.whatsapp.net",
        replyToSenderE164: "+919022233366",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
    expect(result.reason).toBe("explicit_other_agent_address");
    expect(result.debug.ownerSelfReply).toBe(true);
  });

  it("treats Kavish naming shoar inside a bare-you ask as a self pull", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "i do have to work on your supression thingy tho shoar\ninstead of supressing you, i am forcing you to summarise\ndo you mind that?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(true);
    expect(result.state).toBe("direct_task_to_self");
    expect(result.reason).toBe("owner_self_reference_pull");
    expect(result.debug.incidentalSelfReference).toBe(true);
    expect(result.debug.secondPersonAddress).toBe(true);
  });

  it("does not let a Kavish self reference steal an explicit Abhay turn", () => {
    const result = decide({
      activation: "always",
      groupMemberNames: new Map([["+817090966969", "Abhay"]]),
      msg: {
        body: "Abhay can you check shoar's suppression thing?",
        senderName: "Kavish",
        senderE164: "+919022233366",
        sender: {
          jid: "919022233366@s.whatsapp.net",
          e164: "+919022233366",
          name: "Kavish",
        },
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
    expect(result.reason).toBe("explicit_other_person_address");
  });

  it("suppresses ambiguous bare-you bot requests even when activation is always", () => {
    const result = decide({
      activation: "always",
      msg: {
        body: "bot can you check this",
        groupSubject: "bot-bros",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
    expect(result.reason).toBe("second_person_without_self_address");
  });

  it("still suppresses ambiguous bot requests when activation is mention-only", () => {
    const result = decide({
      activation: "mention",
      msg: {
        body: "bot can you check this",
        groupSubject: "bot-bros",
      },
    });

    expect(result.allowReply).toBe(false);
    expect(result.state).toBe("direct_task_to_other");
    expect(result.reason).toBe("second_person_without_self_address");
  });
});
