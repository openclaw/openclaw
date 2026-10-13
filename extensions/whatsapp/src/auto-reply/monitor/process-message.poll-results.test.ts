// WhatsApp processMessage attaches stored poll results for the queued chat only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

const {
  resolvePolicyMock,
  buildContextMock,
  isControlCommandMessageMock,
  dispatchBufferedReplyMock,
  replyPlanParamsMock,
  runChannelInboundEventParamsMock,
  runMessageReceivedMock,
  shouldComputeCommandAuthorizedMock,
  trackBackgroundTaskMock,
} = vi.hoisted(() => ({
  resolvePolicyMock: vi.fn(),
  buildContextMock: vi.fn(),
  isControlCommandMessageMock: vi.fn(() => false),
  dispatchBufferedReplyMock: vi.fn(async (_params?: unknown) => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
  replyPlanParamsMock: vi.fn(),
  runChannelInboundEventParamsMock: vi.fn(),
  runMessageReceivedMock: vi.fn(async () => undefined),
  shouldComputeCommandAuthorizedMock: vi.fn(() => false),
  trackBackgroundTaskMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      runChannelInboundEventParamsMock(params);
      return await actual.runChannelInboundEvent(params);
    },
  };
});

vi.mock("../../inbound-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inbound-policy.js")>();
  return {
    ...actual,
    resolveWhatsAppCommandAuthorized: async () => true,
    resolveWhatsAppInboundPolicy: resolvePolicyMock,
  };
});

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    prepareWhatsAppInboundContext: async (
      params: Parameters<typeof actual.prepareWhatsAppInboundContext>[0],
    ) => {
      const prepared = await actual.prepareWhatsAppInboundContext(params);
      return {
        ...prepared,
        ctxPayload: buildContextMock(params),
      };
    },
    createWhatsAppReplyPlan: (...args: unknown[]) => {
      const params = args[0] as { replyResolver?: unknown };
      replyPlanParamsMock(params);
      void dispatchBufferedReplyMock(params);
      return {
        dispatcherOptions: {},
        delivery: { deliver: async () => {} },
        replyOptions: {},
        replyResolver: params.replyResolver,
        finalize: () => true,
      };
    },
    resolveWhatsAppDmRouteTarget: () => null,
    resolveWhatsAppResponsePrefix: () => undefined,
    updateWhatsAppMainLastRoute: () => {},
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "message_received",
    runMessageReceived: runMessageReceivedMock,
  }),
}));

vi.mock("../../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../identity.js")>();
  return {
    ...actual,
    getPrimaryIdentityId: () => null,
    getSelfIdentity: () => ({ e164: "+15550001111" }),
    getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
  };
});

vi.mock("../../reconnect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../reconnect.js")>();
  return { ...actual, newConnectionId: () => "test-conn-id" };
});

vi.mock("../../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../session.js")>();
  return { ...actual, formatError: (e: unknown) => String(e) };
});

vi.mock("../deliver-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deliver-reply.js")>();
  return { ...actual, deliverWebReply: async () => {} };
});

vi.mock("../loggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loggers.js")>();
  return {
    ...actual,
    whatsappInboundLog: { info: () => {}, debug: () => {} },
  };
});

vi.mock("./ack-reaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ack-reaction.js")>();
  return { ...actual, maybeSendAckReaction: async () => {} };
});

vi.mock("./inbound-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-context.js")>();
  return {
    ...actual,
    resolveVisibleWhatsAppGroupHistory: (params: { history: unknown[] }) => params.history,
    resolveVisibleWhatsAppReplyContext: () => null,
  };
});

vi.mock("./last-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./last-route.js")>();
  return {
    ...actual,
    trackBackgroundTask: trackBackgroundTaskMock,
    updateLastRouteInBackground: () => {},
  };
});

vi.mock("./message-line.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-line.js")>();
  return { ...actual, buildInboundLine: () => "hi" };
});

vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    buildHistoryContextFromEntries: () => "hi",
    createChannelMessageReplyPipeline: () => ({
      onModelSelected: () => {},
      responsePrefix: undefined,
    }),
    formatInboundEnvelope: () => "hi",
    logVerbose: () => {},
    normalizeE164: (v: string) => v,
    recordSessionMetaFromInbound: async () => {},
    resolveChannelContextVisibilityMode: () => "off",
    resolveInboundSessionEnvelopeContext: () => ({
      storePath: "/tmp",
      envelopeOptions: {},
      previousTimestamp: undefined,
    }),
    resolvePinnedMainDmOwnerFromAllowlist: () => null,
    isControlCommandMessage: isControlCommandMessageMock,
    shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
    shouldLogVerbose: () => false,
  };
});

import {
  readWhatsAppPollRecord,
  recordWhatsAppPoll,
  WHATSAPP_POLL_CHAT_INDEX_STORES,
} from "../../poll-vote-store.js";
import { applyWhatsAppPollVote } from "../../poll-vote-tally-store.js";
import {
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "../../poll-vote.test-helper.js";
import { processMessage } from "./process-message.js";

const GROUP_JID = "120363000000000001@g.us";
const PEER_E164 = "+15550002222";
const PEER_PN = "15550002222@s.whatsapp.net";
const PEER_LID = "88880002222@lid";

let env: WhatsAppPollStateRuntimeForTest;

function makePolicy() {
  return {
    account: { accountId: "default", authDir: "/tmp/wa-test-auth", groups: {} },
    dmPolicy: "pairing",
    groupPolicy: "open",
    configuredAllowFrom: [],
    dmAllowFrom: [],
    groupAllowFrom: [],
    isSelfChat: false,
    providerMissingFallbackApplied: false,
    isSamePhone: () => false,
    resolveConversationGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveConversationRequireMention: () => false,
  };
}

const MEDIA_ENTRY = { label: "WhatsApp media", source: "whatsapp", type: "media", payload: {} };

function makeMsg(params: { kind: "group" | "direct"; withMedia?: boolean }) {
  const group = params.kind === "group";
  return createTestWebInboundMessage({
    event: { id: "msg1", timestamp: 1710000000 },
    payload: {
      body: "@bot what did the poll say?",
      ...(params.withMedia ? { channelStructuredContext: [MEDIA_ENTRY] } : {}),
    },
    platform: {
      chatJid: group ? GROUP_JID : PEER_LID,
      recipientJid: "+15550001111",
      senderJid: PEER_PN,
      senderE164: PEER_E164,
      senderName: "Alice",
      sendComposing: async () => {},
      reply: async () => createAcceptedWhatsAppSendResult("text", "r1"),
      sendMedia: async () => createAcceptedWhatsAppSendResult("media", "m1"),
    },
    admission: {
      accountId: "default",
      conversation: { kind: params.kind, id: group ? GROUP_JID : PEER_E164 },
      sender: { id: PEER_E164 },
      senderAccess: { reasonCode: group ? "group_policy_allowed" : "dm_policy_allowlisted" },
    },
  });
}

function callProcessMessage(msg: unknown, agentId = "main") {
  return processMessage({
    cfg: {} as never,
    msg: msg as never,
    route: {
      agentId,
      channel: "whatsapp",
      accountId: "default",
      sessionKey: `agent:${agentId}:whatsapp:chat`,
      mainSessionKey: `agent:${agentId}:whatsapp:chat`,
      lastRoutePolicy: "main",
      matchedBy: "default",
    } as never,
    groupHistoryKey: "whatsapp:default:chat",
    groupHistories: new Map() as never,
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024,
    replyResolver: (async () => undefined) as never,
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    backgroundTasks: new Set(),
  });
}

function preparedEntries(callIndex = 0) {
  const params = buildContextMock.mock.calls.at(callIndex)?.[0] as
    | { msg: { payload: { channelStructuredContext?: Array<{ type?: string }> } } }
    | undefined;
  if (!params) {
    throw new Error(`expected prepared context call ${callIndex}`);
  }
  return params.msg.payload.channelStructuredContext ?? [];
}

async function addPoll(chatJid: string) {
  await recordWhatsAppPoll(
    {
      accountId: "default",
      pollMessageId: "POLL1",
      origin: "sent",
      chatJids: [chatJid],
      creatorJids: ["15550001111@s.whatsapp.net"],
      question: "Pizza or sushi?",
      secret: new Uint8Array(32).fill(3),
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    },
    { mode: "overwrite" },
  );
  const record = await readWhatsAppPollRecord("default", "POLL1");
  if (!record) {
    throw new Error("expected poll record");
  }
  await applyWhatsAppPollVote({
    record,
    accountId: "default",
    pollMessageId: "POLL1",
    voter: { jids: [PEER_PN], name: "Alice" },
    selected: ["Sushi"],
    votedAtMs: 1000,
  });
}

describe("processMessage poll results context", () => {
  beforeEach(async () => {
    env = await installWhatsAppPollStateRuntimeForTest();
    buildContextMock.mockReset();
    buildContextMock.mockImplementation(() => ({ Body: "hi" }));
    resolvePolicyMock.mockReset();
    resolvePolicyMock.mockReturnValue(makePolicy());
    isControlCommandMessageMock.mockReturnValue(false);
    shouldComputeCommandAuthorizedMock.mockReturnValue(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.cleanup();
  });

  it("appends the poll results block after existing entries without mutating the queued message", async () => {
    await addPoll(GROUP_JID);
    const msg = makeMsg({ kind: "group", withMedia: true });
    await callProcessMessage(msg);
    const entries = preparedEntries();
    expect(entries.map((entry) => entry.type)).toEqual(["media", "poll_results"]);
    expect(JSON.stringify(entries[1])).toContain('"voters":["Alice"]');
    expect(msg.payload.channelStructuredContext).toEqual([MEDIA_ENTRY]);
  });

  it("gives each broadcast agent exactly one block", async () => {
    await addPoll(GROUP_JID);
    const msg = makeMsg({ kind: "group" });
    await callProcessMessage(msg, "main");
    await callProcessMessage(msg, "second");
    expect(preparedEntries(0).map((entry) => entry.type)).toEqual(["poll_results"]);
    expect(preparedEntries(1).map((entry) => entry.type)).toEqual(["poll_results"]);
    expect(msg.payload.channelStructuredContext).toBeUndefined();
  });

  it("finds a direct-chat poll under the PN JID derived from the conversation E.164", async () => {
    await addPoll(PEER_PN);
    await callProcessMessage(makeMsg({ kind: "direct" }));
    expect(preparedEntries().map((entry) => entry.type)).toEqual(["poll_results"]);
  });

  it("continues without a block and warns once when the results read fails", async () => {
    await addPoll(GROUP_JID);
    env.faults.push({
      namespace: WHATSAPP_POLL_CHAT_INDEX_STORES.sent.namespace,
      method: "entriesInKeyRange",
      code: "PLUGIN_STATE_READ_FAILED",
    });
    await expect(callProcessMessage(makeMsg({ kind: "group", withMedia: true }))).resolves.toBe(
      true,
    );
    expect(preparedEntries().map((entry) => entry.type)).toEqual(["media"]);
    expect(env.logger.warn).toHaveBeenCalledTimes(1);
    expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll results read failed", {
      code: "PLUGIN_STATE_READ_FAILED",
    });
  });

  it("attaches nothing when the chat has no polls", async () => {
    await addPoll("120363000000000002@g.us");
    await callProcessMessage(makeMsg({ kind: "group" }));
    expect(preparedEntries()).toEqual([]);
  });
});
