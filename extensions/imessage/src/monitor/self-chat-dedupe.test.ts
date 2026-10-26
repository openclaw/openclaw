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

function selfChatMessage(overrides: Partial<InboundDecisionParams["message"]> = {}) {
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

function useFakeTimersAt(iso = DEFAULT_FAKE_TIME) {
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

function expectDecision(decision: Awaited<ReturnType<typeof resolveDecision>>, reason?: string) {
  if (reason) {
    expect(decision).toEqual({ kind: "drop", reason });
  } else {
    expect(decision.kind).toBe("dispatch");
  }
}

describe("self-chat dedupe", () => {
  it.each([
    ["user text", { id: 200 }, undefined, undefined],
    [
      "agent echo",
      selfChatMessage({ guid: "p:0/agent-msg-1" }),
      undefined,
      "agent echo in self-chat",
    ],
    [
      "real image",
      selfChatMessage({ guid: "p:0/user-image", text: "" }),
      [IMAGE_MEDIA_FACT],
      undefined,
    ],
  ] as const)(
    "distinguishes %s from recently sent content",
    async (_name, message, mediaFacts, reason) => {
      useFakeTimersAt();
      echoCache.remember(SELF_CHAT_SCOPE, {
        text: "Hello",
        media: IMAGE_MEDIA_FACT,
        messageId: "p:0/agent-msg-1",
      });
      vi.advanceTimersByTime(2000);
      expectDecision(await resolveDecision({ message, mediaFacts, echoCache }), reason);
    },
  );
  it("drops DM false positives even when participant lists include the local handle", async () => {
    expect(
      await resolveDecision({
        echoCache,
        message: selfChatMessage({
          destination_caller_id: "me@icloud.com",
          participants: [SELF_CHAT_HANDLE, "me@icloud.com"],
        }),
      }),
    ).toEqual({ kind: "drop", reason: "from me" });
  });

  it.each([
    ["self-chat permits sub-second skew", SELF_CHAT_HANDLE, 239, 0, "dispatch", "drop"],
    ["ambiguous DM rejects sub-second skew", null, 239, 0, "drop", "dispatch"],
    ["missing destination matches exact timestamp (#63980)", undefined, 0, 2200, "drop", "drop"],
  ] as const)("%s", async (_name, destination, skew, delay, outboundKind, inboundKind) => {
    useFakeTimersAt();
    const resolveThread = (is_from_me: boolean) =>
      resolveDecision({
        message: threadMessage({
          id: is_from_me ? 10003 : 10004,
          guid: destination === undefined ? undefined : `p:0/${is_from_me}`,
          is_from_me,
          destination_caller_id: is_from_me
            ? destination
            : destination === undefined
              ? undefined
              : null,
          created_at: new Date(
            Date.parse(DEFAULT_FAKE_TIME) + (is_from_me ? 0 : skew),
          ).toISOString(),
        }),
      });
    expectDecision(await resolveThread(true), outboundKind === "drop" ? "from me" : undefined);
    vi.advanceTimersByTime(delay);
    expectDecision(
      await resolveThread(false),
      inboundKind === "drop" ? "self-chat echo" : undefined,
    );
  });

  it("drops catchup-replayed self-chat reflection after observing skipped from-me companion", async () => {
    useFakeTimersAt("2026-06-03T03:48:42Z");
    const text = "Catchup reflection";
    const message = threadMessage({ text });
    rememberIMessageSkippedFromMeForSelfChatDedupe({
      accountId: "default",
      message: selfChatMessage({ ...message, id: 86798, created_at: "2026-06-03T03:48:28.922Z" }),
      bodyText: text,
      selfChatCache,
    });

    const reflection = await resolveDecision({
      message: {
        ...message,
        id: 86799,
        destination_caller_id: `tel:${SELF_CHAT_HANDLE}`,
        created_at: "2026-06-03T03:48:28.738Z",
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
      expectDecision(
        await resolveDecision({
          message: { id, chat_identifier: SELF_CHAT_HANDLE, destination_caller_id, text },
          echoCache,
        }),
        isEcho ? "echo" : undefined,
      );
    },
  );

  it("still identifies echo via text when inbound message has id: null", async () => {
    useFakeTimersAt();
    echoCache.remember(SELF_CHAT_SCOPE, { text: "Sounds good" });
    vi.advanceTimersByTime(1000);
    expect(
      await resolveDecision({ message: { id: null, text: "Sounds good" }, echoCache }),
    ).toEqual({
      kind: "drop",
      reason: "echo",
    });
  });
});
