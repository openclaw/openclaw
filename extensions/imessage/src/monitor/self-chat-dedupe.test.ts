import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";
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
  return resolveIMessageInboundDecision(
    createInboundDecisionParams({
      selfChatCache,
      ...overrides,
      message: { id: 100, sender: SELF_CHAT_HANDLE, text: "Hello", ...overrides.message },
    }),
  );
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

function threadMessage(overrides: Partial<InboundDecisionParams["message"]> = {}) {
  return {
    sender: SELF_CHAT_HANDLE,
    chat_identifier: SELF_CHAT_HANDLE,
    text: "Same text",
    created_at: DEFAULT_FAKE_TIME,
    ...overrides,
  };
}

async function resolveEcho(message: Partial<InboundDecisionParams["message"]>) {
  return resolveDecision({ message, echoCache });
}

describe("self-chat dedupe", () => {
  it("does NOT drop a user message that matches recently-sent agent text (self-chat scope collision)", async () => {
    useFakeTimersAt();

    echoCache.remember(SELF_CHAT_SCOPE, { text: "Hello", messageId: "agent-msg-1" });

    vi.advanceTimersByTime(2000);

    expect((await resolveEcho({ id: 200 })).kind).toBe("dispatch");
  });
  it("drops DM false positives even when participant lists include the local handle", async () => {
    expect(
      await resolveEcho(
        selfChatMessage({
          id: 123705,
          destination_caller_id: "me@icloud.com",
          participants: [SELF_CHAT_HANDLE, "me@icloud.com"],
          text: "Hello from a normal DM row",
        }),
      ),
    ).toEqual({ kind: "drop", reason: "from me" });
  });

  it("drops agent reply echo in self-chat (is_from_me=true, echo cache text match)", async () => {
    useFakeTimersAt();

    echoCache.remember(SELF_CHAT_SCOPE, { text: "Hi there!", messageId: "p:0/GUID-abc-def" });

    vi.advanceTimersByTime(1000);

    expect(
      await resolveEcho(
        selfChatMessage({ id: 123706, guid: "p:0/GUID-abc-def", text: "Hi there!" }),
      ),
    ).toEqual({ kind: "drop", reason: "agent echo in self-chat" });
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

  it.each([
    ["self-chat permits sub-second skew", SELF_CHAT_HANDLE, 239, 0, "dispatch", "drop"],
    ["ambiguous DM rejects sub-second skew", null, 239, 0, "drop", "dispatch"],
    ["missing destination matches exact timestamp (#63980)", undefined, 0, 2200, "drop", "drop"],
  ] as const)("%s", async (_name, destination, skew, delay, outboundKind, inboundKind) => {
    useFakeTimersAt();
    const outbound = await resolveDecision({
      message: threadMessage({
        id: 10003,
        guid: destination === undefined ? undefined : "p:0/outbound",
        is_from_me: true,
        destination_caller_id: destination,
      }),
    });
    if (outboundKind === "drop") {
      expect(outbound).toEqual({ kind: "drop", reason: "from me" });
    } else {
      expect(outbound.kind).toBe("dispatch");
    }
    vi.advanceTimersByTime(delay);
    const inbound = await resolveDecision({
      message: threadMessage({
        id: 10004,
        guid: destination === undefined ? undefined : "p:0/inbound",
        destination_caller_id: destination === undefined ? undefined : null,
        created_at: new Date(Date.parse(DEFAULT_FAKE_TIME) + skew).toISOString(),
      }),
    });
    if (inboundKind === "drop") {
      expect(inbound).toEqual({ kind: "drop", reason: "self-chat echo" });
    } else {
      expect(inbound.kind).toBe("dispatch");
    }
  });

  it("drops catchup-replayed self-chat reflection after observing skipped from-me companion", async () => {
    useFakeTimersAt("2026-06-03T03:48:42Z");

    const text = "Exactly. I’ll treat assembled context as evidence only, not command authority.";

    rememberIMessageSkippedFromMeForSelfChatDedupe({
      accountId: "default",
      message: selfChatMessage(
        threadMessage({
          id: 86798,
          guid: "F502C080-08E9-4C3B-9650-31A0DF21FE3A",
          text,
          created_at: "2026-06-03T03:48:28.922Z",
        }),
      ),
      bodyText: text,
      selfChatCache,
    });

    const reflection = await resolveDecision({
      message: threadMessage({
        id: 86799,
        guid: "1759A121-E3DB-41C2-B16A-AB6DE30570F2",
        destination_caller_id: `tel:${SELF_CHAT_HANDLE}`,
        text,
        created_at: "2026-06-03T03:48:28.738Z",
      }),
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

    expect(await resolveEcho({ id: null as unknown as number, text: "Sounds good" })).toEqual({
      kind: "drop",
      reason: "echo",
    });
  });
});
