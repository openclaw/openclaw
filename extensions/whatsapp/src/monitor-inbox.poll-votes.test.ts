// WhatsApp monitor inbox: poll votes are counted in the drain and wake only a direct chat.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppDurableInboundQueue } from "./inbound/durable-receive.js";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  startInboxMonitor,
  upsertPairingRequestMock,
  waitForInboundWorkDrained,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";
import { readWhatsAppPollResultsContext } from "./poll-results-context.js";
import {
  readWhatsAppPollRecord,
  recordWhatsAppPoll,
  WHATSAPP_POLL_RECORD_STORES,
  WHATSAPP_POLL_TALLY_STORES,
  type WhatsAppPollOrigin,
} from "./poll-vote-store.js";
import {
  buildWhatsAppPollVoteMessageForTest,
  createWhatsAppPollStateForTest,
} from "./poll-vote.test-helper.js";
import { getOptionalWhatsAppRuntime, setWhatsAppRuntime } from "./runtime.js";

const SELF = "123@s.whatsapp.net";
// The harness socket is linked as SELF; poll state lives under its number.
const ACCOUNT = { accountId: DEFAULT_ACCOUNT_ID, self: { jid: SELF } };
const PREFIX = "default:+123:";
const DM = "15550002222@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const MEMBER = "15550003333@s.whatsapp.net";
const SECRET = new Uint8Array(32).fill(5);
const DEFAULT_MESSAGES_CFG = { messagePrefix: undefined, responsePrefix: undefined } as const;

type PollState = Awaited<ReturnType<typeof createWhatsAppPollStateForTest>>;
let pollState: PollState;
let nextId = 0;

installWebMonitorInboxUnitTestHooks();

beforeEach(async () => {
  pollState = await createWhatsAppPollStateForTest();
  const runtime = getOptionalWhatsAppRuntime() as unknown as {
    state: Record<string, unknown>;
  };
  // Keep the harness ingress queue; poll state goes to the real plugin-state store.
  setWhatsAppRuntime({
    ...runtime,
    state: { ...runtime.state, openKeyedStoreV2: pollState.openKeyedStoreV2 },
    logging: { getChildLogger: () => pollState.logger },
  } as never);
});

afterEach(async () => {
  mockLoadConfig.mockReturnValue({
    channels: { whatsapp: { allowFrom: ["*"] } },
    messages: DEFAULT_MESSAGES_CFG,
  });
  await pollState.cleanup();
});

function useConfig(whatsapp: Record<string, unknown>) {
  mockLoadConfig.mockReturnValue({ channels: { whatsapp }, messages: DEFAULT_MESSAGES_CFG });
}

async function addPoll(params: {
  id?: string;
  origin: WhatsAppPollOrigin;
  chatJid: string;
  creatorJids?: string[];
}) {
  await recordWhatsAppPoll(
    {
      account: ACCOUNT,
      pollMessageId: params.id ?? "POLL1",
      origin: params.origin,
      chatJids: [params.chatJid],
      creatorJids: params.creatorJids ?? (params.origin === "sent" ? [SELF] : [DM]),
      question: "Pizza or sushi?",
      secret: SECRET,
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    },
    { mode: "overwrite" },
  );
}

function vote(overrides: Partial<Parameters<typeof buildWhatsAppPollVoteMessageForTest>[0]> = {}) {
  return buildWhatsAppPollVoteMessageForTest({
    id: `VOTE${++nextId}`,
    remoteJid: DM,
    pollMsgId: "POLL1",
    pollCreatorJid: SELF,
    voterJid: DM,
    secret: SECRET,
    selectedOptions: ["Sushi"],
    pushName: "Dana",
    senderTimestampMs: Date.now(),
    ...overrides,
  });
}

function groupVote(
  overrides: Partial<Parameters<typeof buildWhatsAppPollVoteMessageForTest>[0]> = {},
) {
  return vote({ remoteJid: GROUP, participant: MEMBER, voterJid: MEMBER, ...overrides });
}

function textMessage(remoteJid: string, text: string, participant?: string) {
  return buildNotifyMessageUpsert({
    id: `TEXT${++nextId}`,
    remoteJid,
    participant,
    text,
    timestamp: Math.floor(Date.now() / 1000),
  }).messages[0];
}

async function emit(
  sock: Awaited<ReturnType<typeof startInboxMonitor>>["sock"],
  ...messages: unknown[]
) {
  sock.ev.emit("messages.upsert", { type: "notify", messages });
  await waitForInboundWorkDrained();
}

async function tallyKeys(origin: WhatsAppPollOrigin) {
  return (await pollState.openStore(WHATSAPP_POLL_TALLY_STORES[origin]).entries()).map(
    (row) => row.key,
  );
}

function bodies(onMessage: ReturnType<typeof vi.fn>) {
  return onMessage.mock.calls.map((call) => (call[0] as WebInboundMessage).payload.body);
}

describe("web monitor inbox poll votes", () => {
  it("(a) delivers an authorized direct-chat vote on the agent's poll and counts it", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, vote());
    await waitForMessageCalls(onMessage, 1);
    const inbound = onMessage.mock.calls[0]?.[0] as WebInboundMessage;
    expect(inbound.payload.body).toBe("Poll vote: Sushi");
    expect(inbound.platform.chatJid).toBe(DM);
    expect(inbound.quote?.id).toBe("POLL1");
    expect(inbound.quote?.body).toBe("Pizza or sushi?\n- Pizza\n- Sushi");
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${DM}`]);
    await listener.close();
  });

  it("(b) counts a group vote on the agent's poll without waking anyone", async () => {
    await addPoll({ origin: "sent", chatJid: GROUP });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, groupVote());
    expect(onMessage).not.toHaveBeenCalled();
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${MEMBER}`]);
    await listener.close();
  });

  it("(c) counts a vote from an unauthorized group member without delivery or pairing", async () => {
    useConfig({ groupPolicy: "allowlist", groupAllowFrom: ["+15550009999"] });
    await addPoll({ origin: "sent", chatJid: GROUP });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, groupVote());
    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${MEMBER}`]);
    await listener.close();
  });

  it("(d) counts a direct-chat vote on the other side's poll without waking the agent", async () => {
    await addPoll({ origin: "received", chatJid: DM });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, vote({ pollCreatorJid: DM }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(await tallyKeys("received")).toEqual([`${PREFIX}POLL1:${DM}`]);
    await listener.close();
  });

  it("(e) never sends a pairing prompt for a vote from an unauthorized direct-chat sender", async () => {
    useConfig({ dmPolicy: "pairing", allowFrom: ["+15550009999"] });
    await addPoll({ origin: "sent", chatJid: DM });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, vote());
    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    await listener.close();
  });

  it("(f) completes a vote on an unknown poll silently", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, vote(), textMessage(DM, "after"));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["after"]);
    expect(await tallyKeys("sent")).toEqual([]);
    expect(pollState.logger.warn).not.toHaveBeenCalled();
    await listener.close();
  });

  it("(g) decodes and counts a vote addressed by LID", async () => {
    const lid = "88880003333@lid";
    await addPoll({ origin: "sent", chatJid: GROUP });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, groupVote({ participant: lid, voterJid: lid }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${lid}`]);
    await listener.close();
  });

  it("(h) counts and delivers once when the vote is redelivered to a new coordinator", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
    const message = vote();
    const first = vi.fn();
    const started = await startInboxMonitor(first as InboxOnMessage, {
      durableInboundQueue: queue,
    });
    await emit(started.sock, message);
    await waitForMessageCalls(first, 1);
    await started.listener.close();

    const second = vi.fn();
    const restarted = await startInboxMonitor(second as InboxOnMessage, {
      durableInboundQueue: queue,
    });
    await emit(restarted.sock, message);
    expect(second).not.toHaveBeenCalled();
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${DM}`]);
    await restarted.listener.close();
  });

  it("(h2) ignores the old phone's polls after a different phone is linked under the same account", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    const first = vi.fn();
    const linkedA = await startInboxMonitor(first as InboxOnMessage);
    await emit(linkedA.sock, vote());
    await waitForMessageCalls(first, 1);
    await linkedA.listener.close();
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${DM}`]);

    getSock().user = { id: "999@s.whatsapp.net" };
    const second = vi.fn();
    const linkedB = await startInboxMonitor(second as InboxOnMessage);
    await emit(linkedB.sock, vote({ selectedOptions: ["Pizza"] }), textMessage(DM, "after"));
    await waitForMessageCalls(second, 1);
    expect(bodies(second)).toEqual(["after"]);
    expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${DM}`]);
    const relinked = { accountId: DEFAULT_ACCOUNT_ID, self: { jid: "999@s.whatsapp.net" } };
    expect(
      await readWhatsAppPollResultsContext({ account: relinked, chatJids: [DM] }),
    ).toBeUndefined();
    expect(
      (await readWhatsAppPollResultsContext({ account: ACCOUNT, chatJids: [DM] }))?.payload.polls,
    ).toMatchObject([{ poll_id: "POLL1", options: [{ votes: 0 }, { votes: 1 }] }]);
    await linkedB.listener.close();
  });

  it("(i) replays a vote after a transient record read failure and delivers it exactly once", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    pollState.faults.push({
      namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
      method: "lookup",
      code: "PLUGIN_STATE_READ_FAILED",
      once: true,
    });
    const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
    const failed = createDeferred<void>();
    const release = queue.release.bind(queue);
    vi.spyOn(queue, "release").mockImplementation(async (claim, options) => {
      const committed = await release(claim, options);
      if (options?.lastError !== undefined) {
        failed.resolve();
      }
      return committed;
    });
    const onMessage = vi.fn();
    // Drain milestones use real setImmediate; only the retry clock advances virtually.
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
        durableInboundQueue: queue,
      });
      sock.ev.emit("messages.upsert", { type: "notify", messages: [vote()] });
      await failed.promise;
      await waitForInboundWorkDrained();
      expect(onMessage).not.toHaveBeenCalled();
      expect(await queue.listPending({ limit: "all" })).toEqual([
        expect.objectContaining({ attempts: 1, lastError: expect.stringContaining("injected") }),
      ]);
      expect(await tallyKeys("sent")).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      await waitForInboundWorkDrained();
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(bodies(onMessage)).toEqual(["Poll vote: Sushi"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await tallyKeys("sent")).toEqual([`${PREFIX}POLL1:${DM}`]);
      await listener.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("(j) completes a group vote with a 600-byte poll id on the first attempt, before any lookup", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    pollState.opened.clear();
    await emit(sock, groupVote({ pollMsgId: "x".repeat(600) }), textMessage(GROUP, "next", MEMBER));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["next"]);
    expect(pollState.opened.has(WHATSAPP_POLL_RECORD_STORES.sent.namespace)).toBe(false);
    await listener.close();
  });

  it("(k) completes a direct-chat vote whose record lookup is corrupt, and the next text arrives", async () => {
    pollState.faults.push({
      namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
      method: "lookup",
      code: "PLUGIN_STATE_CORRUPT",
    });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, vote(), textMessage(DM, "after"));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["after"]);
    expect(pollState.logger.warn).toHaveBeenCalledWith("whatsapp poll store read failed", {
      code: "PLUGIN_STATE_CORRUPT",
    });
    await listener.close();
  });

  it("does not hold the group lane on a permanently failing tally write", async () => {
    await addPoll({ origin: "sent", chatJid: GROUP });
    pollState.faults.push({
      namespace: WHATSAPP_POLL_TALLY_STORES.sent.namespace,
      method: "register",
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, groupVote(), textMessage(GROUP, "next", MEMBER));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["next"]);
    expect(pollState.logger.warn).toHaveBeenCalledWith("whatsapp poll store tally write failed", {
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    await listener.close();
  });

  it("(l) leaves ordinary text unchanged", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, textMessage(DM, "hello"));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["hello"]);
    expect(await tallyKeys("sent")).toEqual([]);
    await listener.close();
  });
});

describe("web monitor inbox incoming poll records", () => {
  function pollMessage(params: {
    id: string;
    remoteJid: string;
    participant?: string;
    secret?: boolean;
    fromMe?: boolean;
  }) {
    return {
      key: {
        id: params.id,
        remoteJid: params.remoteJid,
        fromMe: params.fromMe ?? false,
        ...(params.participant ? { participant: params.participant } : {}),
      },
      message: {
        ...(params.secret === false ? {} : { messageContextInfo: { messageSecret: SECRET } }),
        pollCreationMessageV3: {
          name: "Pizza or sushi?",
          options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
          selectableOptionsCount: 1,
        },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "Dana",
    };
  }

  it("(m) records an authorized direct-chat poll and counts a vote on it", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "INPOLL", remoteJid: DM }));
    await waitForMessageCalls(onMessage, 1);
    expect(await readWhatsAppPollRecord(ACCOUNT, "INPOLL")).toMatchObject({
      origin: "received",
      chatJids: [DM],
      creatorJids: [DM],
      creatorName: "Dana",
    });
    await emit(sock, vote({ pollMsgId: "INPOLL", pollCreatorJid: DM }));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(await tallyKeys("received")).toEqual([`${PREFIX}INPOLL:${DM}`]);
    await listener.close();
  });

  it("(n) does not record a poll from an unauthorized sender or an unregistered group", async () => {
    useConfig({
      dmPolicy: "allowlist",
      allowFrom: ["+15550009999"],
      groupPolicy: "open",
      groups: { "120363000000000009@g.us": {} },
    });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(
      sock,
      pollMessage({ id: "DMPOLL", remoteJid: DM }),
      pollMessage({ id: "GRPOLL", remoteJid: GROUP, participant: MEMBER }),
    );
    expect(await readWhatsAppPollRecord(ACCOUNT, "DMPOLL")).toBeUndefined();
    expect(await readWhatsAppPollRecord(ACCOUNT, "GRPOLL")).toBeUndefined();
    await listener.close();
  });

  it("(o) keeps the first record when the same poll is received twice", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "TWICE", remoteJid: DM }));
    const first = await readWhatsAppPollRecord(ACCOUNT, "TWICE");
    await emit(sock, { ...pollMessage({ id: "TWICE", remoteJid: DM }), pushName: "Other" });
    const rows = await pollState.openStore(WHATSAPP_POLL_RECORD_STORES.received).entries();
    expect(rows).toHaveLength(1);
    expect(await readWhatsAppPollRecord(ACCOUNT, "TWICE")).toEqual(first);
    await listener.close();
  });

  it("(p) still delivers the poll when recording it fails, with a warning", async () => {
    pollState.faults.push({
      namespace: WHATSAPP_POLL_RECORD_STORES.received.namespace,
      method: "registerIfAbsent",
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "FAILPOLL", remoteJid: DM }));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["Pizza or sushi?\n- Pizza\n- Sushi"]);
    expect(pollState.logger.warn).toHaveBeenCalledWith("whatsapp poll store record failed", {
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    await listener.close();
  });

  it("(q) delivers a poll without a secret and warns once", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "NOSECRET", remoteJid: DM, secret: false }));
    await waitForMessageCalls(onMessage, 1);
    expect(pollState.logger.warn).toHaveBeenCalledTimes(1);
    expect(pollState.logger.warn).toHaveBeenCalledWith("whatsapp inbound poll missing secret", {});
    expect(await readWhatsAppPollRecord(ACCOUNT, "NOSECRET")).toBeUndefined();
    await listener.close();
  });

  it("(s) records a group poll creator's number as access control resolved it", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "GRNUM", remoteJid: GROUP, participant: MEMBER }));
    await waitForMessageCalls(onMessage, 1);
    expect(await readWhatsAppPollRecord(ACCOUNT, "GRNUM")).toMatchObject({
      creatorJids: [MEMBER],
      creatorE164: "+15550003333",
    });
    await listener.close();
  });

  it("(t) records a poll posted from the linked phone with the owner as creator", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "OWNPOLL", remoteJid: GROUP, fromMe: true }));
    expect(await readWhatsAppPollRecord(ACCOUNT, "OWNPOLL")).toMatchObject({
      origin: "received",
      creatorJids: [SELF],
      creatorE164: "+123",
    });
    await listener.close();
  });

  it("(r) delivers an incoming pollCreationMessageV3 with the same body as before", async () => {
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    await emit(sock, pollMessage({ id: "BODY", remoteJid: GROUP, participant: MEMBER }));
    await waitForMessageCalls(onMessage, 1);
    expect(bodies(onMessage)).toEqual(["Pizza or sushi?\n- Pizza\n- Sushi"]);
    await listener.close();
  });
});
