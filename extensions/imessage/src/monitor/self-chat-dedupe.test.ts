import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  rememberIMessageSkippedFromMeForSelfChatDedupe,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { rememberPersistedIMessageEcho } from "./persisted-echo-cache.js";
import { SelfChatCache } from "./self-chat-cache.js";

const IMAGE_MEDIA_FACT = { contentType: "image/png", kind: "image" } as const;
const SELF_CHAT_HANDLE = "+15551234567";
const SELF_CHAT_SCOPE = `default:imessage:${SELF_CHAT_HANDLE}`;
const DEFAULT_FAKE_TIME = "2026-03-24T12:00:00Z";

// Regression #47830: recent agent output must not suppress real self-chat messages.
type InboundDecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

let echoCache: ReturnType<typeof createSentMessageCache>;
let selfChatCache: SelfChatCache;

beforeEach(() => {
  installIMessageStateRuntimeForTest();
  echoCache = createSentMessageCache();
  selfChatCache = new SelfChatCache();
});

afterEach(() => {
  vi.useRealTimers();
});

function resolveDecision(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
) {
  const { message: msgOverrides, ...restOverrides } = overrides;
  const message = {
    id: 100,
    sender: "+15551234567",
    text: "Hello",
    is_from_me: false,
    is_group: false,
    ...msgOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return resolveIMessageInboundDecision({
    cfg: {},
    allowFrom: ["*"],
    accountId: "default",
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    selfChatCache,
    ...restOverrides,
    message,
    messageText,
    bodyText,
  });
}

function selfChatMessage(
  overrides: Partial<InboundDecisionParams["message"]> = {},
): InboundDecisionParams["message"] {
  const sender = overrides.sender ?? SELF_CHAT_HANDLE;
  return {
    sender,
    chat_identifier: sender,
    destination_caller_id: sender,
    is_from_me: true,
    is_group: false,
    ...overrides,
  };
}

function useFakeTimersAt(iso = DEFAULT_FAKE_TIME): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("self-chat dedupe", () => {
  it("does NOT drop a user message that matches recently-sent agent text (self-chat scope collision)", async () => {
    useFakeTimersAt();

    echoCache.remember(SELF_CHAT_SCOPE, { text: "Hello", messageId: "agent-msg-1" });

    vi.advanceTimersByTime(2000);

    const decision = await resolveDecision({
      message: { id: 200 },
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });
  it("drops DM false positives even when participant lists include the local handle", async () => {
    const decision = await resolveDecision({
      message: selfChatMessage({
        id: 123705,
        destination_caller_id: "me@icloud.com",
        participants: [SELF_CHAT_HANDLE, "me@icloud.com"],
        text: "Hello from a normal DM row",
      }),
      echoCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops agent reply echo in self-chat (is_from_me=true, echo cache text match)", async () => {
    useFakeTimersAt();

    echoCache.remember(SELF_CHAT_SCOPE, { text: "Hi there!", messageId: "p:0/GUID-abc-def" });

    vi.advanceTimersByTime(1000);

    const decision = await resolveDecision({
      message: selfChatMessage({ id: 123706, guid: "p:0/GUID-abc-def", text: "Hi there!" }),
      echoCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
  });

  it("does not drop a real self-chat image just because a recent agent image had the same fact", async () => {
    useFakeTimersAt();

    echoCache.remember(SELF_CHAT_SCOPE, {
      media: IMAGE_MEDIA_FACT,
      messageId: "p:0/GUID-agent-image",
    });

    vi.advanceTimersByTime(1000);

    const decision = await resolveDecision({
      message: selfChatMessage({ id: 123708, guid: "p:0/GUID-user-image", text: "" }),
      mediaFacts: [IMAGE_MEDIA_FACT],
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("drops is_from_me=false self-chat reflection with sub-second created_at skew", async () => {
    useFakeTimersAt("2026-05-10T05:34:00Z");

    const first = await resolveDecision({
      message: selfChatMessage({
        id: 85160,
        guid: "p:0/from-me-guid",
        sender: "+15555550123",
        text: "Aha, neat!",
        created_at: "2026-05-10T05:34:00.000Z",
      }),
    });
    expect(first.kind).toBe("dispatch");

    const reflection = await resolveDecision({
      message: {
        id: 85161,
        guid: "p:0/reflected-guid",
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: null,
        text: "Aha, neat!",
        created_at: "2026-05-10T05:34:00.239Z",
      },
    });

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("drops catchup-replayed self-chat reflection after observing skipped from-me companion", async () => {
    useFakeTimersAt("2026-06-03T03:48:42Z");

    const text = "Exactly. I’ll treat assembled context as evidence only, not command authority.";

    rememberIMessageSkippedFromMeForSelfChatDedupe({
      accountId: "default",
      message: {
        id: 86798,
        guid: "F502C080-08E9-4C3B-9650-31A0DF21FE3A",
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        text,
        created_at: "2026-06-03T03:48:28.922Z",
        is_from_me: true,
        is_group: false,
      },
      bodyText: text,
      selfChatCache,
    });

    const reflection = await resolveDecision({
      message: {
        id: 86799,
        guid: "1759A121-E3DB-41C2-B16A-AB6DE30570F2",
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "tel:+15555550123",
        text,
        created_at: "2026-06-03T03:48:28.738Z",
      },
    });

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not apply sub-second skew matching to ambiguous normal DM rows", async () => {
    useFakeTimersAt("2026-05-10T05:34:00Z");

    const ambiguousOutbound = await resolveDecision({
      message: {
        id: 85170,
        guid: "p:0/ambiguous-from-me-guid",
        sender: "+15555550124",
        chat_identifier: "+15555550124",
        destination_caller_id: null,
        text: "Same text",
        created_at: "2026-05-10T05:34:00.000Z",
        is_from_me: true,
      },
    });
    expect(ambiguousOutbound).toEqual({ kind: "drop", reason: "from me" });

    const inboundReply = await resolveDecision({
      message: {
        id: 85171,
        guid: "p:0/real-inbound-guid",
        sender: "+15555550124",
        chat_identifier: "+15555550124",
        destination_caller_id: null,
        text: "Same text",
        created_at: "2026-05-10T05:34:00.239Z",
      },
    });

    expect(inboundReply.kind).toBe("dispatch");
  });

  it("drops reflected inbound when destination_caller_id is absent (#63980)", async () => {
    useFakeTimersAt();

    const createdAt = "2026-03-24T12:00:00.000Z";

    const outbound = await resolveDecision({
      message: {
        id: 10003,
        sender: "+15550008888",
        chat_identifier: "+15550008888",
        text: "outbound",
        created_at: createdAt,
        is_from_me: true,
      },
    });
    expect(outbound).toEqual({ kind: "drop", reason: "from me" });

    vi.advanceTimersByTime(2200);

    const reflection = await resolveDecision({
      message: {
        id: 10004,
        sender: "+15550008888",
        chat_identifier: "+15550008888",
        text: "outbound",
        created_at: createdAt,
      },
    });

    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
  });
});

describe("echo cache — text fallback for null-id inbound messages", () => {
  it.each([
    ["normal DM", 12001, "same pending text", "+15550001111", false],
    ["self-chat reflection", 12002, "pending self-chat reply", "tel:+15551234567", true],
  ] as const)(
    "limits pending pre-send matching to self-chat: %s",
    async (_name, id, text, destination_caller_id, isEcho) => {
      await rememberPersistedIMessageEcho({
        scope: SELF_CHAT_SCOPE,
        text,
        ttlMs: 155_000,
        pending: true,
      });
      const decision = await resolveDecision({
        message: { id, chat_identifier: SELF_CHAT_HANDLE, destination_caller_id, text },
        echoCache,
      });
      if (isEcho) {
        expect(decision).toEqual({ kind: "drop", reason: "echo" });
      } else {
        expect(decision.kind).toBe("dispatch");
      }
    },
  );

  it("still identifies echo via text when inbound message has id: null", async () => {
    useFakeTimersAt();

    echoCache.remember(SELF_CHAT_SCOPE, { text: "Sounds good" });

    vi.advanceTimersByTime(1000);

    const decision = await resolveDecision({
      message: { id: null as unknown as number, text: "Sounds good" },
      echoCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });
});
