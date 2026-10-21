import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { noteGroupMember } from "./group-members.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";
import { trackBackgroundTask } from "./last-route.js";

type ReplyContextParams = Parameters<typeof resolveVisibleWhatsAppReplyContext>[0];
const visibility = {
  mode: "allowlist",
  groupPolicy: "allowlist",
  groupAllowFrom: ["+111"],
} as const satisfies Omit<ReplyContextParams, "msg">;
const visibleReply = (msg: ReplyContextParams["msg"]) =>
  resolveVisibleWhatsAppReplyContext({ msg, ...visibility });
const historyEntry = (name: string, phone: string, body: string) => ({
  sender: `${name} (${phone})`,
  body,
  senderJid: `${phone.slice(1)}@s.whatsapp.net`,
});

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
      conversation: { kind: "group", id: "123@g.us" },
      sender: { id: "111@s.whatsapp.net" },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
    quote: {
      id: "blocked-reply",
      body: "Blocked quoted text",
      sender: { displayName: "Mallory (+999)", jid: "999@s.whatsapp.net" },
    },
  });

describe("whatsapp inbound context visibility", () => {
  it("filters non-allowlisted group history from supplemental context", () => {
    const allowed = historyEntry("Alice", "+111", "Allowed context");
    const history = resolveVisibleWhatsAppGroupHistory({
      history: [allowed, historyEntry("Mallory", "+999", "Blocked context")],
      ...visibility,
    });

    expect(history).toEqual([historyEntry("Alice", "+111", "Allowed context")]);
  });

  it("redacts blocked quoted replies in allowlist mode", () => {
    expect(visibleReply(makeBlockedQuotedReplyMessage("msg-reply-1"))).toBeNull();
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

    const reply = visibleReply(msg);

    expect(reply?.body).toBe("<media:sticker>");
    expect(reply?.media).toEqual({ contentType: "image/webp", kind: "sticker" });
  });
});

it("ignores incomplete group member values", () => {
  const groupMemberNames = new Map<string, Map<string, string>>();

  noteGroupMember(groupMemberNames, "g1", undefined, "Alice");
  noteGroupMember(groupMemberNames, "g1", "+15551234567", undefined);

  expect(groupMemberNames.get("g1")).toBeUndefined();
});

describe("trackBackgroundTask", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("does not leak unhandled rejections when a tracked task fails", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const backgroundTasks = new Set<Promise<unknown>>();
    const { promise: task, reject } = createDeferred<void>();

    trackBackgroundTask(backgroundTasks, task);
    expect(backgroundTasks.size).toBe(1);

    reject(new Error("boom"));
    await Promise.allSettled([task]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(backgroundTasks.size).toBe(0);
    expect(unhandledRejections).toStrictEqual([]);
  });
});
