import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock all external dependencies so we can instantiate the real handler.
vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  loadConfig: vi.fn(() => ({
    channels: { whatsapp: { enabled: true, groupPolicy: "allowlist", groups: {} } },
    commands: {},
    messages: {},
    session: {},
  })),
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: vi.fn(() => ({
    agentId: "test-agent",
    sessionKey: "agent:test-agent:main",
    mainSessionKey: "agent:test-agent:main",
    accountId: "default",
  })),
  buildGroupHistoryKey: vi.fn(() => "whatsapp:default:group:test-group"),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => {
  const verboseMessages: string[] = [];
  return {
    logVerbose: vi.fn((msg: string) => verboseMessages.push(msg)),
    shouldLogVerbose: vi.fn(() => true),
    getChildLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    __verboseMessages: verboseMessages,
  };
});

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeE164: vi.fn((v: string) => v),
  jidToE164: vi.fn((v: string) => v),
}));

vi.mock("./group-gating.js", () => ({
  applyGroupGating: vi.fn(() => ({ shouldProcess: true })),
}));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: vi.fn(async () => false),
}));

vi.mock("./process-message.js", () => ({
  processMessage: vi.fn(async () => true),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: vi.fn(),
  trackBackgroundTask: vi.fn(),
}));

vi.mock("./peer.js", () => ({
  resolvePeerId: vi.fn(() => "120363408809173967@g.us"),
}));

import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { WebInboundMsg } from "../types.js";
import { createWebOnMessageHandler } from "./on-message.js";
import { processMessage } from "./process-message.js";

function makeMsg(overrides: Partial<WebInboundMsg> = {}): WebInboundMsg {
  return {
    id: "msg-1",
    body: "Hello from the group",
    from: "120363408809173967@g.us",
    to: "+971506443271",
    conversationId: "120363408809173967@g.us",
    accountId: "default",
    chatType: "group",
    chatId: "120363408809173967@g.us",
    fromMe: false,
    senderJid: "215233729704@lid",
    senderE164: "+923006761319",
    senderName: "Test User",
    selfJid: "971506443271@s.whatsapp.net",
    selfE164: "+971506443271",
    groupSubject: "Test Group",
    groupParticipants: [],
    mentionedJids: [],
    sendComposing: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as WebInboundMsg;
}

function createHandler(overrides?: { echoTrackerHas?: (key: string) => boolean }) {
  const echoTracker = {
    rememberText: vi.fn(),
    has: overrides?.echoTrackerHas ?? vi.fn(() => false),
    forget: vi.fn(),
    buildCombinedKey: vi.fn(
      (p: { sessionKey: string; combinedBody: string }) =>
        `combined:${p.sessionKey}:${p.combinedBody}`,
    ),
  };

  const handler = createWebOnMessageHandler({
    cfg: {
      channels: { whatsapp: { enabled: true, groupPolicy: "allowlist", groups: {} } },
      commands: {},
      messages: {},
      session: {},
    } as ReturnType<typeof import("openclaw/plugin-sdk/config-runtime").loadConfig>,
    verbose: true,
    connectionId: "test-conn",
    maxMediaBytes: 20_971_520,
    groupHistoryLimit: 20,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker,
    backgroundTasks: new Set(),
    replyResolver: vi.fn() as never,
    replyLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    baseMentionConfig: { requireMention: false },
    account: { accountId: "default" },
  });

  return { handler, echoTracker };
}

describe("on-message fromMe echo protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips fromMe messages in group chats and never calls processMessage", async () => {
    const { handler, echoTracker } = createHandler();
    const msg = makeMsg({ fromMe: true, chatType: "group" });

    await handler(msg);

    // processMessage should NOT have been called
    expect(processMessage).not.toHaveBeenCalled();

    // echoTracker.has should NOT have been called (fromMe exits before it)
    expect(echoTracker.has).not.toHaveBeenCalled();

    // logVerbose should have logged the skip reason
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("Skipping auto-reply: fromMe message"),
    );
  });

  it("processes non-fromMe messages from group members normally", async () => {
    const { handler } = createHandler();
    const msg = makeMsg({ fromMe: false, chatType: "group" });

    await handler(msg);

    // processMessage SHOULD have been called
    expect(processMessage).toHaveBeenCalled();
  });

  it("skips fromMe messages in direct chats when not same phone", async () => {
    const { handler } = createHandler();
    const msg = makeMsg({
      fromMe: true,
      chatType: "direct",
      from: "+923006761319",
      to: "+971506443271",
      selfE164: "+971506443271",
    });

    await handler(msg);

    expect(processMessage).not.toHaveBeenCalled();
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("Skipping auto-reply: fromMe message in direct"),
    );
  });

  it("allows fromMe messages in same-phone self-chat DMs", async () => {
    const { handler } = createHandler();
    const msg = makeMsg({
      fromMe: true,
      chatType: "direct",
      from: "+971506443271",
      to: "+971506443271",
      selfE164: "+971506443271",
      conversationId: "+971506443271",
    });

    await handler(msg);

    // Self-chat should be processed — user is messaging their own number
    expect(processMessage).toHaveBeenCalled();
  });

  it("still uses echo tracker as fallback when fromMe is false but text matches", async () => {
    const echoHas = vi.fn(() => true);
    const { handler, echoTracker } = createHandler({ echoTrackerHas: echoHas });
    const msg = makeMsg({ fromMe: false, body: "echoed text" });

    await handler(msg);

    // fromMe is false, so echo tracker should be checked
    expect(echoHas).toHaveBeenCalledWith("echoed text");
    // Echo was detected, so forget should be called
    expect(echoTracker.forget).toHaveBeenCalledWith("echoed text");
    // processMessage should NOT have been called (echo detected)
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("treats undefined fromMe as non-fromMe and processes the message", async () => {
    const { handler } = createHandler();
    const msg = makeMsg({ fromMe: undefined });

    await handler(msg);

    // undefined is falsy — message should be processed
    expect(processMessage).toHaveBeenCalled();
  });
});
