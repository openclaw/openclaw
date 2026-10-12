// Whatsapp tests cover inbound context plugin behavior.
import { afterEach, describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { formatGroupMembers, noteGroupMember } from "./group-members.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";
import { trackBackgroundTask } from "./last-route.js";

type ReplyContextParams = Parameters<typeof resolveVisibleWhatsAppReplyContext>[0];

const makeBlockedQuotedReplyMessage = (id: string): ReplyContextParams["msg"] =>
  createTestWebInboundMessage({
    event: { id },
    payload: { body: "Current message" },
    platform: {
      chatJid: "123@g.us",
      recipientJid: "+2000",
      senderName: "Alice",
      senderJid: "111@s.whatsapp.net",
      senderE164: "+111",
      selfE164: "+999",
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "group",
        id: "123@g.us",
      },
      sender: {
        id: "111@s.whatsapp.net",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    quote: {
      id: "blocked-reply",
      body: "Blocked quoted text",
      sender: {
        displayName: "Mallory (+999)",
        jid: "999@s.whatsapp.net",
      },
    },
  });

describe("whatsapp inbound context visibility", () => {
  it("filters non-allowlisted group history from supplemental context", () => {
    const history = resolveVisibleWhatsAppGroupHistory({
      history: [
        {
          sender: "Alice (+111)",
          body: "Allowed context",
          senderJid: "111@s.whatsapp.net",
        },
        {
          sender: "Mallory (+999)",
          body: "Blocked context",
          senderJid: "999@s.whatsapp.net",
        },
      ],
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(history).toEqual([
      {
        sender: "Alice (+111)",
        body: "Allowed context",
        senderJid: "111@s.whatsapp.net",
      },
    ]);
  });

  it("redacts blocked quoted replies in allowlist mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      msg: makeBlockedQuotedReplyMessage("msg-reply-1"),
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(reply).toBeNull();
  });

  it("keeps blocked quoted replies in allowlist_quote mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      msg: makeBlockedQuotedReplyMessage("msg-reply-2"),
      mode: "allowlist_quote",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(reply).toEqual({
      id: "blocked-reply",
      body: "Blocked quoted text",
      sender: {
        jid: "999@s.whatsapp.net",
        lid: null,
        e164: "+999",
        label: "Mallory (+999)",
      },
    });
  });

  it("renders structured quoted media only at the visible preview boundary", () => {
    const msg = makeBlockedQuotedReplyMessage("msg-reply-media");
    msg.quote = {
      context: {
        id: "quoted-sticker",
        body: "",
        media: { contentType: "image/webp", kind: "sticker" },
        sender: { jid: "111@s.whatsapp.net", label: "Alice (+111)" },
      },
    };

    const reply = resolveVisibleWhatsAppReplyContext({
      msg,
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(reply?.body).toBe("<media:sticker>");
    expect(reply?.media).toEqual({ contentType: "image/webp", kind: "sticker" });
  });
});

describe("group member display", () => {
  it("normalizes member phone numbers before storing", () => {
    const groupMemberNames = new Map<string, Map<string, string>>();

    noteGroupMember(groupMemberNames, "g1", "+1 (555) 123-4567", "Alice");

    expect(groupMemberNames.get("g1")?.get("+15551234567")).toBe("Alice");
  });

  it("ignores incomplete member values", () => {
    const groupMemberNames = new Map<string, Map<string, string>>();

    noteGroupMember(groupMemberNames, "g1", undefined, "Alice");
    noteGroupMember(groupMemberNames, "g1", "+15551234567", undefined);

    expect(groupMemberNames.get("g1")).toBeUndefined();
  });

  it.each([
    {
      name: "deduplicates participants and appends named roster members",
      params: {
        participants: ["+1 (555) 000-0000", "+15550000000", "+16660000000"],
        roster: new Map([
          ["+16660000000", "Bob"],
          ["+17770000000", "Carol"],
        ]),
      },
      expected: "+15550000000, Bob (+16660000000), Carol (+17770000000)",
    },
    {
      name: "falls back to sender when no participants or roster are available",
      params: {
        participants: [],
        roster: undefined,
        fallbackE164: "+1 (555) 222-3333",
      },
      expected: "+15552223333",
    },
    {
      name: "returns undefined when no members can be resolved",
      params: { participants: [], roster: undefined },
      expected: undefined,
    },
  ])("$name", ({ params, expected }) => {
    expect(formatGroupMembers(params)).toBe(expected);
  });
});

describe("trackBackgroundTask", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("does not leak unhandled rejections when a tracked task fails", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const backgroundTasks = new Set<Promise<unknown>>();
    let rejectTask: ((reason?: unknown) => void) | undefined;
    const task = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });

    trackBackgroundTask(backgroundTasks, task);
    expect(backgroundTasks.size).toBe(1);

    if (!rejectTask) {
      throw new Error("Expected tracked task reject callback to be initialized");
    }
    rejectTask(new Error("boom"));
    await Promise.allSettled([task]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(backgroundTasks.size).toBe(0);
    expect(unhandledRejections).toStrictEqual([]);
  });
});
