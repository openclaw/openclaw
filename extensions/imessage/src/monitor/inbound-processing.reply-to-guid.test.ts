// iMessage reply_to_guid echo detection regression tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installIMessageStateRuntimeForTest,
  loadFreshIMessageReplyCacheForTest,
} from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";
import { hasPersistedIMessageEcho, rememberPersistedIMessageEcho } from "./persisted-echo-cache.js";
import { createSelfChatCache } from "./self-chat-cache.js";

type InboundProcessingModule = typeof import("./inbound-processing.js");
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];
const cfg = {} as OpenClawConfig;
type InboundDecisionParams = Parameters<
  InboundProcessingModule["resolveIMessageInboundDecision"]
>[0];

beforeAll(async () => {
  await loadFreshIMessageReplyCacheForTest();
  ({ resolveIMessageInboundDecision } = await import("./inbound-processing.js"));
});

afterEach(() => {
  vi.useRealTimers();
});

function createInboundDecisionParams(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
): InboundDecisionParams {
  const { message: messageOverrides, ...restOverrides } = overrides;
  const message = {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...messageOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return {
    cfg,
    accountId: "default",
    opts: undefined,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    isKnownFromMeMessageId: () => false,
    logVerbose: undefined,
    ...restOverrides,
    message,
    messageText,
    bodyText,
  };
}

function resolveDecision(overrides: Parameters<typeof createInboundDecisionParams>[0] = {}) {
  return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
}

describe("resolveIMessageInboundDecision reply_to_guid echo detection", () => {
  it("drops paired mirror with reply_to_guid matching outbound echo cache guid", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15555550123";
    // The mirror shares the outbound row's createdAt, so the self-chat cache
    // verifies it as a reflection rather than a genuine recipient reply.
    selfChatCache.remember({
      accountId: "default",
      isGroup: false,
      sender: "+15555550123",
      text: "Hello",
      createdAt: Date.parse("2026-05-08T12:00:00Z"),
    });
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 100,
        guid: "GUID-B",
        reply_to_guid: "GUID-A",
        text: "Hello",
        sender: "+15555550123",
        created_at: "2026-05-08T12:00:00Z",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
      selfChatCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not drop inline reply with reply_to_guid but different text", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 101,
        guid: "GUID-C",
        reply_to_guid: "GUID-A",
        text: "Goodbye",
      },
      messageText: "Goodbye",
      bodyText: "Goodbye",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop message with identical text but unrelated reply_to_guid", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 102,
        guid: "GUID-D",
        reply_to_guid: "GUID-UNRELATED",
        text: "Hello",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop inline reply whose text matches a different outbound GUID", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });
    echoCache.remember(scope, { text: "Okay", messageId: "GUID-B" });

    const decision = await resolveDecision({
      message: {
        id: 103,
        guid: "GUID-C",
        reply_to_guid: "GUID-A",
        text: "Okay",
      },
      messageText: "Okay",
      bodyText: "Okay",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop authored self-chat row with reply_to_guid matching outbound", async () => {
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 104,
        guid: "GUID-E",
        reply_to_guid: "GUID-A",
        text: "Hello",
        is_from_me: true,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
      selfChatCache,
    });

    expect(decision.kind).not.toBe("drop");
  });

  it("still drops paired mirror with reply_to_guid within the reflection window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15555550123";
    // Remember the outbound send so the self-chat cache can verify the mirror
    // (mirrors share createdAt with their outbound row).
    selfChatCache.remember({
      accountId: "default",
      isGroup: false,
      sender: "+15555550123",
      text: "Hello",
      createdAt: Date.parse("2026-05-08T12:00:00Z"),
    });
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    // Reflections arrive within ~2.2s; 2s is inside the 4s reflection window.
    vi.advanceTimersByTime(2_000);

    const decision = await resolveDecision({
      message: {
        id: 201,
        guid: "GUID-B",
        reply_to_guid: "GUID-A",
        text: "Hello",
        sender: "+15555550123",
        created_at: "2026-05-08T12:00:00Z",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
      selfChatCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "self-chat echo" });
  });

  it("does not drop ordinary direct-chat same-text reply within the reflection window", async () => {
    // A recipient replies to an outbound message with the same text within 4s.
    // The row carries reply_to_guid + matching body just like a mirror, but it
    // is a genuine user message, not a verified reflection: no self-chat
    // destination and the self-chat cache has no matching outbound row. The
    // probe must not drop it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    vi.advanceTimersByTime(2_000);

    const decision = await resolveDecision({
      message: {
        id: 210,
        guid: "GUID-B",
        reply_to_guid: "GUID-A",
        text: "Hello",
        sender: "+15555550123",
        // No destination_caller_id / chat_identifier match → not a self-chat.
        // Real recipient reply has its own createdAt, not the outbound row's.
        created_at: "2026-05-08T12:00:02Z",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop same-text reply_to_guid inline reply after the reflection window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    // Past the 4s reflection window but within the legacy 60s id-only TTL.
    // A genuine same-text threaded reply arriving now must be preserved.
    vi.advanceTimersByTime(5_000);

    const decision = await resolveDecision({
      message: { id: 202, guid: "GUID-B", reply_to_guid: "GUID-A", text: "Hello" },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("suppresses a direct-chat reflection cached under the production chat_id scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const echoCache = createSentMessageCache();
    const selfChatCache = createSelfChatCache();
    // Production direct sends persist the outbound echo under accountId:chat_id:<id>
    // (see send.ts:resolveOutboundEchoScope when target.kind === "chat_id").
    const scope = "default:chat_id:42";
    selfChatCache.remember({
      accountId: "default",
      isGroup: false,
      chatId: 42,
      sender: "+15555550123",
      text: "Hello",
      createdAt: Date.parse("2026-05-08T12:00:00Z"),
    });
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    vi.advanceTimersByTime(2_000);

    const decision = await resolveDecision({
      message: {
        id: 203,
        guid: "GUID-B",
        reply_to_guid: "GUID-A",
        text: "Hello",
        is_group: false,
        chat_id: 42,
        sender: "+15555550123",
        created_at: "2026-05-08T12:00:00Z",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
      selfChatCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "self-chat echo" });
  });
});

describe("persisted reply_to_guid reflection window", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("does not match a persisted parent/body pair after the reflection window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00Z"));
    const scope = "default:imessage:+15555550123";
    rememberPersistedIMessageEcho({ scope, text: "Hello", messageId: "GUID-A" });

    // Within the reflection window: the strict reply_to_guid match succeeds.
    vi.advanceTimersByTime(2_000);
    expect(
      hasPersistedIMessageEcho({
        scope,
        text: "Hello",
        messageId: "GUID-A",
        requireMessageIdTextMatch: true,
      }),
    ).toBe(true);

    // Past the reflection window (but well within the 12h retention): the strict
    // parent/body heuristic must NOT fire, so a genuine same-text inline reply
    // is not dropped hours later.
    vi.advanceTimersByTime(3_000);
    expect(
      hasPersistedIMessageEcho({
        scope,
        text: "Hello",
        messageId: "GUID-A",
        requireMessageIdTextMatch: true,
      }),
    ).toBe(false);

    // Exact outbound-GUID matching (no requireMessageIdTextMatch) still honors
    // the full 12h retention so reconnect re-emits are still recognized.
    expect(hasPersistedIMessageEcho({ scope, messageId: "GUID-A" })).toBe(true);
  });
});
