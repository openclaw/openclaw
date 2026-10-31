// Slack tests prove thread-participation admission at the Slack write boundary:
// createSlackMessageHandler → prepare → dispatch → send run for real; only the
// agent turn and the Slack HTTP client are replaced.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
  recordSlackThreadParticipation,
} from "../sent-thread-cache.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
} from "./message-handler/prepare.test-helpers.js";

const FINAL_REPLY_TEXT = "workspace participation reply";

type CapturedTurn = Parameters<
  typeof import("openclaw/plugin-sdk/channel-inbound").dispatchChannelInboundTurn
>[0];

// Replace the agent turn, not the downstream delivery lifecycle.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    dispatchChannelInboundTurn: async (params: CapturedTurn) => {
      const payload = { text: FINAL_REPLY_TEXT };
      const transformed = params.dispatcherOptions?.transformReplyPayload
        ? params.dispatcherOptions.transformReplyPayload(payload)
        : payload;
      const dispatcher = createReplyDispatcher({
        deliver: params.delivery.deliver,
        onError: params.delivery.onError,
      });
      if (transformed) {
        dispatcher.sendFinalReply(transformed);
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        admission: { kind: "dispatch" } as const,
        dispatched: true as const,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: {
          queuedFinal: Boolean(transformed),
          counts: { tool: 0, block: 0, final: transformed ? 1 : 0 },
          observedReplyDelivery: true,
        },
      };
    },
  };
});

// send.ts/actions.ts build their own WebClient from tokens; route every client
// resolution to the test's recording client so all wire calls are captured.
const slackWireClient = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  const useWireClient = () => {
    if (!slackWireClient.current) {
      throw new Error("recording Slack client not installed");
    }
    return slackWireClient.current as never;
  };
  return {
    ...actual,
    createSlackReadClient: useWireClient,
    createSlackWebClient: useWireClient,
    createSlackLookupClient: useWireClient,
    createSlackWriteClient: useWireClient,
    createSlackStartupAuthClient: useWireClient,
    getSlackWriteClient: useWireClient,
    getSlackListenerWriteClient: useWireClient,
  };
});

type WireCall = { method: string; args: Record<string, unknown> };

function createRecordingWireClient(calls: WireCall[]): Record<string, unknown> {
  let tsCounter = 0;
  const nextTs = () => `1700000002.${String(++tsCounter).padStart(6, "0")}`;
  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  const acknowledge = (method: string) => async (args: Record<string, unknown>) => {
    record(method, args);
    return { ok: true, ts: args.ts, channel: args.channel };
  };
  return {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        const ts = nextTs();
        record("chat.postMessage", args);
        return {
          ok: true,
          channel: args.channel,
          ts,
          message: { ts, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) },
        };
      },
      update: acknowledge("chat.update"),
      delete: acknowledge("chat.delete"),
      startStream: async (args: Record<string, unknown>) => {
        const ts = nextTs();
        record("chat.startStream", args);
        return { ok: true, ts };
      },
      appendStream: acknowledge("chat.appendStream"),
      stopStream: acknowledge("chat.stopStream"),
    },
    reactions: {
      add: acknowledge("reactions.add"),
      remove: acknowledge("reactions.remove"),
    },
    users: {
      info: async (args: Record<string, unknown>) => {
        record("users.info", args);
        return { ok: true, user: { team_id: "T1" } };
      },
    },
    conversations: {
      open: acknowledge("conversations.open"),
      history: async (args: Record<string, unknown>) => {
        record("conversations.history", args);
        return { ok: true, messages: [] };
      },
      replies: async (args: Record<string, unknown>) => {
        record("conversations.replies", args);
        return { ok: true, messages: [] };
      },
    },
    apiCall: async (method: string, args: Record<string, unknown>) => {
      record(method, args);
      return { ok: true };
    },
  };
}

const storeFixture = createSlackSessionStoreFixture("slack-thread-participation-workspace-");
const THREAD_TS = "1700000000.000000";

function createRequireMentionConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        enabled: true,
        groupPolicy: "open",
        streaming: { mode: "off" },
        channels: { C123: { requireMention: true } },
      },
    },
    session: {},
  } as OpenClawConfig;
}

function createFollowUp(ts: string): SlackMessageEvent {
  return {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    user: "U1",
    text: "ordinary follow-up",
    ts,
    thread_ts: THREAD_TS,
    parent_user_id: "U2",
  };
}

async function handleFollowUp(params: {
  ts: string;
  wireCalls: WireCall[];
  eventScopeTeamId?: string;
  afterContext?: () => void;
}): Promise<void> {
  const client = createRecordingWireClient(params.wireCalls);
  slackWireClient.current = client;
  const cfg = createRequireMentionConfig();
  setRuntimeConfigSnapshot(cfg, cfg);
  const ctx = createInboundSlackTestContext({
    cfg,
    appClient: client as never,
    channelsConfig: { C123: { requireMention: true } },
  });
  ctx.resolveUserName = async () => ({ name: "Alice" });
  ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });
  params.afterContext?.();
  const { storePath } = storeFixture.makeTmpStorePath();
  vi.spyOn(
    await import("openclaw/plugin-sdk/session-store-runtime"),
    "resolveStorePath",
  ).mockReturnValue(storePath);
  const handler = createSlackMessageHandler({ ctx });
  await handler(createFollowUp(params.ts), {
    source: "message",
    awaitDispatch: true,
    ...(params.eventScopeTeamId
      ? {
          eventScope: {
            teamId: params.eventScopeTeamId,
            client: client as never,
          },
        }
      : {}),
  });
}

describe("slack inbound thread participation before Slack reply I/O", () => {
  beforeEach(() => {
    clearSlackThreadParticipationCache();
    resetPluginStateStoreForTests();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    slackWireClient.current = undefined;
    setSlackRuntime(null as never);
  });

  it("posts the follow-up reply to Slack when send recorded the monitor workspace", async () => {
    recordSlackThreadParticipation("default", "C123", THREAD_TS, { teamId: "T1" });
    const wireCalls: WireCall[] = [];

    await handleFollowUp({ ts: "1700000001.000001", wireCalls });

    const posts = wireCalls.filter((call) => call.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.args).toMatchObject({
      channel: "C123",
      thread_ts: THREAD_TS,
      text: expect.stringContaining(FINAL_REPLY_TEXT),
    });
    // Dispatch re-records participation with resolveSlackParticipationTeamId:
    // no event scope resolves to the monitor workspace T1.
    expect(hasSlackThreadParticipation("default", "C123", THREAD_TS, "T1")).toBe(true);
  });

  it("produces zero Slack wire calls for a different enterprise workspace", async () => {
    recordSlackThreadParticipation("default", "C123", THREAD_TS, { teamId: "T1" });
    const wireCalls: WireCall[] = [];

    await handleFollowUp({
      ts: "1700000001.000002",
      wireCalls,
      eventScopeTeamId: "T2",
    });

    expect(wireCalls).toEqual([]);
  });

  it("posts after upgrade when only a pre-change unscoped store record exists", async () => {
    await withOpenClawTestState(
      {
        label: "slack-inbound-unscoped-upgrade",
        layout: "state-only",
        applyEnv: false,
      },
      async (state) => {
        const preUpgradeStore = createPluginStateKeyedStoreForTests<{ repliedAt: number }>(
          "slack",
          {
            namespace: "slack.thread-participation",
            maxEntries: 1000,
            env: state.env,
          },
        );
        await preUpgradeStore.register(`default:C123:${THREAD_TS}`, { repliedAt: Date.now() });
        resetPluginStateStoreForTests();
        clearSlackThreadParticipationCache();
        const wireCalls: WireCall[] = [];

        await handleFollowUp({
          ts: "1700000001.000003",
          wireCalls,
          afterContext: () => {
            const runtime = getSlackRuntime();
            setSlackRuntime({
              ...runtime,
              state: {
                ...runtime.state,
                openKeyedStoreV2: (options: OpenKeyedStoreOptions) =>
                  createPluginStateKeyedStoreV2ForTests<{ repliedAt: number }>(
                    "slack",
                    { ...options, env: state.env },
                    { assertCurrent() {} },
                  ),
              },
            } as never);
          },
        });

        const posts = wireCalls.filter((call) => call.method === "chat.postMessage");
        expect(posts).toHaveLength(1);
        expect(posts[0]?.args).toMatchObject({ channel: "C123", thread_ts: THREAD_TS });
      },
    );
  });
});
