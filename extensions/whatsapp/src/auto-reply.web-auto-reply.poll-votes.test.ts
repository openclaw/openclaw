// End to end: socket votes never wake a group, are stored, and the agent sees them when asked.
import fs from "node:fs/promises";
import path from "node:path";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupHistoryEntry } from "./auto-reply/monitor/inbound-context.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";
import {
  DEFAULT_ACCOUNT_ID,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  startInboxMonitor,
  waitForInboundWorkDrained,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";
import {
  buildWhatsAppPollVoteMessageForTest,
  createWhatsAppPollStateForTest,
} from "./poll-vote.test-helper.js";
import { getOptionalWhatsAppRuntime, setWhatsAppRuntime } from "./runtime.js";

const SELF = "123@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const OPEN_GROUP = "120363000000000002@g.us";
const OTHER_GROUP = "120363000000000003@g.us";
const DANA = "15550003333@s.whatsapp.net";
const ELI = "15550004444@s.whatsapp.net";
const NOA = "15550005555@s.whatsapp.net";
const DM_E164 = "+15550002222";
const DM = "15550002222@s.whatsapp.net";
const MEMBER_SECRET = new Uint8Array(32).fill(4);

type ReplyContext = {
  Body?: string;
  SessionKey?: string;
  ChannelStructuredContext?: Array<{ type?: string; payload?: unknown }>;
};
type PollState = Awaited<ReturnType<typeof createWhatsAppPollStateForTest>>;
type Sock = Awaited<ReturnType<typeof startInboxMonitor>>["sock"];

let pollState: PollState;
let nextId = 0;

installWebMonitorInboxUnitTestHooks();

beforeEach(async () => {
  pollState = await createWhatsAppPollStateForTest();
  const runtime = getOptionalWhatsAppRuntime() as unknown as { state: Record<string, unknown> };
  setWhatsAppRuntime({
    ...runtime,
    state: { ...runtime.state, openKeyedStoreV2: pollState.openKeyedStoreV2 },
    logging: { getChildLogger: () => pollState.logger },
  } as never);
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await pollState.cleanup();
});

function makeCfg(root: string): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: path.join(root, "workspace") },
    },
    session: { dmScope: "per-channel-peer" },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
        groupPolicy: "open",
        groups: {
          [GROUP]: { requireMention: true },
          [OPEN_GROUP]: { requireMention: false },
          [OTHER_GROUP]: { requireMention: true },
        },
        accounts: { work: { allowFrom: ["*"] } },
      },
    },
    messages: { messagePrefix: undefined, responsePrefix: undefined },
  } as OpenClawConfig;
}

async function withPollHome(run: (cfg: OpenClawConfig) => Promise<void>) {
  await withTempHome(
    async (root) => {
      const cfg = makeCfg(root);
      await fs.writeFile(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
      mockLoadConfig.mockReturnValue(cfg);
      // Group turns read recent transcript text through the prepared runtime config.
      setRuntimeConfigSnapshot(cfg);
      await run(cfg);
    },
    {
      prefix: "whatsapp-poll-votes-e2e-",
      env: { OPENCLAW_CONFIG_PATH: (root) => path.join(root, ".openclaw", "openclaw.json") },
    },
  );
}

async function startAgent(cfg: OpenClawConfig, accountId = DEFAULT_ACCOUNT_ID) {
  const replyResolver = vi.fn(async (_ctx: ReplyContext) => undefined);
  // Every context the agent is woken with, whichever reply path then runs.
  const contexts: ReplyContext[] = [];
  const groupHistories = new Map<string, GroupHistoryEntry[]>();
  const backgroundTasks = new Set<Promise<unknown>>();
  const handler = createWebOnMessageHandler({
    cfg,
    verbose: false,
    connectionId: `poll-votes-${accountId}`,
    maxMediaBytes: 1024,
    groupHistoryLimit: 100,
    groupHistories,
    groupMemberNames: new Map(),
    backgroundTasks,
    replyResolver: replyResolver as never,
    replyLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    buildContext: ((params: Parameters<typeof buildChannelInboundEventContext>[0]) => {
      const built = buildChannelInboundEventContext(params);
      contexts.push(built as ReplyContext);
      return built;
    }) as typeof buildChannelInboundEventContext,
  });
  const { listener, sock } = await startInboxMonitor(handler as InboxOnMessage, {
    cfg: cfg as never,
    accountId,
  });
  return {
    listener,
    sock,
    replyResolver,
    contexts,
    groupHistories,
    async settle() {
      await waitForInboundWorkDrained();
      await Promise.allSettled(backgroundTasks);
    },
  };
}

// The drain can finish before an adopted turn reaches the reply resolver.
async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number) {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count), { timeout: 5_000 });
}

async function emit(agent: Awaited<ReturnType<typeof startAgent>>, ...messages: unknown[]) {
  agent.sock.ev.emit("messages.upsert", { type: "notify", messages });
  await agent.settle();
}

function capturedSecret(sock: Sock, callIndex: number): Uint8Array {
  const content = sock.sendMessage.mock.calls[callIndex]?.[1] as {
    poll?: { messageSecret?: Uint8Array };
  };
  const secret = content?.poll?.messageSecret;
  if (!secret) {
    throw new Error("expected a poll with a message secret");
  }
  return secret;
}

function text(
  remoteJid: string,
  body: string,
  opts: { participant?: string; mention?: boolean } = {},
) {
  return {
    key: {
      id: `TEXT${++nextId}`,
      remoteJid,
      fromMe: false,
      ...(opts.participant ? { participant: opts.participant } : {}),
    },
    message: opts.mention
      ? { extendedTextMessage: { text: body, contextInfo: { mentionedJid: [SELF] } } }
      : { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Asker",
  };
}

function memberPoll(id: string) {
  return {
    key: { id, remoteJid: GROUP, fromMe: false, participant: DANA },
    message: {
      messageContextInfo: { messageSecret: MEMBER_SECRET },
      pollCreationMessageV3: {
        name: "Movie night?",
        options: [{ optionName: "Yes" }, { optionName: "No" }],
        selectableOptionsCount: 1,
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Dana",
  };
}

let voteClock = Date.now();

function vote(params: {
  chat: string;
  voter: string;
  name: string;
  poll: string;
  creator: string;
  secret: Uint8Array;
  selected: string[];
}) {
  const group = params.chat.endsWith("@g.us");
  return buildWhatsAppPollVoteMessageForTest({
    id: `VOTE${++nextId}`,
    remoteJid: params.chat,
    ...(group ? { participant: params.voter } : {}),
    voterJid: params.voter,
    pushName: params.name,
    pollMsgId: params.poll,
    pollCreatorJid: params.creator,
    secret: params.secret,
    selectedOptions: params.selected,
    senderTimestampMs: ++voteClock,
  });
}

function pollResults(ctx: ReplyContext | undefined) {
  return ctx?.ChannelStructuredContext?.find((entry) => entry.type === "poll_results")?.payload as
    | {
        polls: Array<{
          question: string;
          created_by: string;
          voters_total: number;
          options: Array<{ option: string; votes: number; voters: string[] }>;
        }>;
      }
    | undefined;
}

function summarize(ctx: ReplyContext | undefined) {
  return pollResults(ctx)?.polls.map((poll) => ({
    question: poll.question,
    created_by: poll.created_by,
    voters_total: poll.voters_total,
    options: poll.options.map(
      ({ option, votes, voters }) => `${option}:${votes}:${voters.join("|")}`,
    ),
  }));
}

async function seedGroupPolls(agent: Awaited<ReturnType<typeof startAgent>>) {
  const sent = await agent.listener.sendPoll(GROUP, {
    question: "Pizza or sushi?",
    options: ["Pizza", "Sushi"],
  });
  const agentPoll = sent.messageId;
  const agentSecret = capturedSecret(agent.sock, agent.sock.sendMessage.mock.calls.length - 1);
  await emit(agent, memberPoll("MEMBERPOLL"));
  const onAgentPoll = { poll: agentPoll, creator: SELF, secret: agentSecret };
  await emit(
    agent,
    vote({ chat: GROUP, voter: DANA, name: "Dana", selected: ["Pizza"], ...onAgentPoll }),
    vote({ chat: GROUP, voter: ELI, name: "Eli", selected: ["Sushi"], ...onAgentPoll }),
    vote({ chat: GROUP, voter: ELI, name: "Eli", selected: ["Pizza"], ...onAgentPoll }),
    vote({ chat: GROUP, voter: NOA, name: "Noa", selected: ["Sushi"], ...onAgentPoll }),
    vote({ chat: GROUP, voter: NOA, name: "Noa", selected: [], ...onAgentPoll }),
    vote({
      chat: GROUP,
      voter: ELI,
      name: "Eli",
      selected: ["No"],
      poll: "MEMBERPOLL",
      creator: DANA,
      secret: MEMBER_SECRET,
    }),
  );
}

const EXPECTED_GROUP_RESULTS = [
  {
    question: "Movie night?",
    created_by: "Dana",
    voters_total: 1,
    options: ["Yes:0:", "No:1:Eli"],
  },
  {
    question: "Pizza or sushi?",
    created_by: "assistant",
    voters_total: 2,
    options: ["Pizza:2:Dana|Eli", "Sushi:0:"],
  },
];

describe("WhatsApp poll votes end to end", () => {
  it("(a) a direct-chat vote on the agent's poll wakes the agent in the same session with results", async () => {
    await withPollHome(async (cfg) => {
      const agent = await startAgent(cfg);
      const sent = await agent.listener.sendPoll(DM_E164, {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      });
      const secret = capturedSecret(agent.sock, agent.sock.sendMessage.mock.calls.length - 1);
      await emit(
        agent,
        vote({
          chat: DM,
          voter: DM,
          name: "Dana",
          poll: sent.messageId,
          creator: SELF,
          secret,
          selected: ["Sushi"],
        }),
      );
      await waitForCalls(agent.replyResolver, 1);
      const voteCtx = agent.replyResolver.mock.calls[0]?.[0];
      expect(voteCtx?.Body).toContain("Poll vote: Sushi");
      expect(summarize(voteCtx)).toEqual([
        {
          question: "Lunch?",
          created_by: "assistant",
          voters_total: 1,
          options: ["Pizza:0:", "Sushi:1:Dana"],
        },
      ]);

      await emit(agent, text(DM, "hello"));
      await waitForCalls(agent.replyResolver, 2);
      expect(agent.replyResolver.mock.calls[1]?.[0]?.SessionKey).toBe(voteCtx?.SessionKey);
      await agent.listener.close();
    });
  });

  it("(b) group votes wake nobody, and a mention after 50 messages sees the final selections", async () => {
    await withPollHome(async (cfg) => {
      const agent = await startAgent(cfg);
      await seedGroupPolls(agent);
      expect(agent.replyResolver).not.toHaveBeenCalled();
      expect(agent.contexts).toEqual([]);

      for (let batch = 0; batch < 5; batch++) {
        await emit(
          agent,
          ...Array.from({ length: 10 }, (_, index) =>
            text(GROUP, `chatter ${batch * 10 + index}`, { participant: DANA }),
          ),
        );
      }
      expect(agent.replyResolver).not.toHaveBeenCalled();
      expect(agent.contexts).toEqual([]);
      const history = JSON.stringify([...agent.groupHistories.values()]);
      expect(history).toContain("chatter 49");
      expect(history).not.toContain("Poll vote");

      await emit(
        agent,
        text(GROUP, "@bot what did the poll say?", { participant: DANA, mention: true }),
      );
      await waitForCalls(agent.replyResolver, 1);
      expect(summarize(agent.replyResolver.mock.calls[0]?.[0])).toEqual(EXPECTED_GROUP_RESULTS);
      await agent.listener.close();
    });
  });

  it("(c) in a group without requireMention votes still wake nobody; the next message carries the block", async () => {
    await withPollHome(async (cfg) => {
      const agent = await startAgent(cfg);
      const sent = await agent.listener.sendPoll(OPEN_GROUP, {
        question: "Tea?",
        options: ["Yes", "No"],
      });
      const pollId = sent.messageId;
      const secret = capturedSecret(agent.sock, agent.sock.sendMessage.mock.calls.length - 1);
      const onPoll = { poll: pollId, creator: SELF, secret };
      await emit(
        agent,
        vote({ chat: OPEN_GROUP, voter: DANA, name: "Dana", selected: ["Yes"], ...onPoll }),
        vote({ chat: OPEN_GROUP, voter: ELI, name: "Eli", selected: ["No"], ...onPoll }),
      );
      expect(agent.contexts).toEqual([]);
      await emit(agent, text(OPEN_GROUP, "anyone?", { participant: NOA }));
      await vi.waitFor(() => expect(agent.contexts).toHaveLength(1), { timeout: 5_000 });
      expect(summarize(agent.contexts[0])).toEqual([
        {
          question: "Tea?",
          created_by: "assistant",
          voters_total: 2,
          options: ["Yes:1:Dana", "No:1:Eli"],
        },
      ]);
      await agent.listener.close();
    });
  });

  it("(d) after a restart with empty histories the same mention gets the same block", async () => {
    await withPollHome(async (cfg) => {
      const first = await startAgent(cfg);
      await seedGroupPolls(first);
      await first.listener.close();

      const restarted = await startAgent(cfg);
      expect(restarted.groupHistories.size).toBe(0);
      await emit(
        restarted,
        text(GROUP, "@bot what did the poll say?", { participant: DANA, mention: true }),
      );
      await waitForCalls(restarted.replyResolver, 1);
      expect(summarize(restarted.replyResolver.mock.calls[0]?.[0])).toEqual(EXPECTED_GROUP_RESULTS);
      await restarted.listener.close();
    });
  });

  it("(e) another group, the voter's direct chat and another account never see the results", async () => {
    await withPollHome(async (cfg) => {
      const agent = await startAgent(cfg);
      await seedGroupPolls(agent);
      await emit(
        agent,
        text(OTHER_GROUP, "@bot what did the poll say?", { participant: DANA, mention: true }),
        text(DANA, "what did the poll say?"),
      );
      await waitForCalls(agent.replyResolver, 2);
      for (const call of agent.replyResolver.mock.calls) {
        expect(pollResults(call[0])).toBeUndefined();
      }
      await agent.listener.close();

      const work = await startAgent(cfg, "work");
      await emit(
        work,
        text(GROUP, "@bot what did the poll say?", { participant: DANA, mention: true }),
      );
      await waitForCalls(work.replyResolver, 1);
      expect(pollResults(work.replyResolver.mock.calls[0]?.[0])).toBeUndefined();
      await work.listener.close();
    });
  });
});
