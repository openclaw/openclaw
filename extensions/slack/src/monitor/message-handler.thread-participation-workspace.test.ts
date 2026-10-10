// Slack tests cover inbound thread-participation admission before reply dispatch.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackRuntime, setSlackRuntime } from "../runtime.js";
import {
  clearSlackThreadParticipationCache,
  recordSlackThreadParticipation,
} from "../sent-thread-cache.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackEventScope } from "./event-scope.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
} from "./message-handler/prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

const dispatchPreparedSlackMessage = vi.fn(async (_prepared: PreparedSlackMessage) => {});

vi.mock("./message-handler/pipeline.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./message-handler/pipeline.runtime.js")>(
    "./message-handler/pipeline.runtime.js",
  );
  return {
    ...actual,
    dispatchPreparedSlackMessage: (...args: Parameters<typeof dispatchPreparedSlackMessage>) =>
      dispatchPreparedSlackMessage(...args),
  };
});

const storeFixture = createSlackSessionStoreFixture("slack-thread-participation-workspace-");
const THREAD_TS = "1700000000.000000";

function createRequireMentionConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        enabled: true,
        groupPolicy: "open",
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

function createHandlerContext() {
  const cfg = createRequireMentionConfig();
  setRuntimeConfigSnapshot(cfg, cfg);
  const ctx = createInboundSlackTestContext({
    cfg,
    channelsConfig: { C123: { requireMention: true } },
  });
  ctx.resolveUserName = async () => ({ name: "Alice" });
  ctx.resolveChannelName = async () => ({ name: "general", type: "channel" });
  return { ctx, cfg };
}

async function handleFollowUp(params: {
  ts: string;
  eventScope?: SlackEventScope;
  afterContext?: () => void;
}): Promise<void> {
  const { ctx } = createHandlerContext();
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
    ...(params.eventScope ? { eventScope: params.eventScope } : {}),
  });
}

describe("slack inbound thread participation before reply dispatch", () => {
  beforeAll(() => {
    storeFixture.setup();
  });

  beforeEach(() => {
    dispatchPreparedSlackMessage.mockClear();
    clearSlackThreadParticipationCache();
    resetPluginStateStoreForTests();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    setSlackRuntime(null as never);
  });

  afterAll(() => {
    storeFixture.cleanup();
  });

  it("dispatches an unmentioned follow-up when send recorded the monitor workspace", async () => {
    recordSlackThreadParticipation("default", "C123", THREAD_TS, { teamId: "T1" });

    await handleFollowUp({ ts: "1700000001.000001" });

    expect(dispatchPreparedSlackMessage).toHaveBeenCalledTimes(1);
    const prepared = dispatchPreparedSlackMessage.mock.calls[0]?.[0];
    expect(prepared?.ctxPayload.MentionSource).toBe("implicit_thread");
    expect(prepared?.ctxPayload.ImplicitMentionKinds).toEqual(["bot_thread_participant"]);
  });

  it("does not dispatch a different enterprise workspace before Slack reply I/O", async () => {
    recordSlackThreadParticipation("default", "C123", THREAD_TS, { teamId: "T1" });

    await handleFollowUp({
      ts: "1700000001.000002",
      eventScope: {
        teamId: "T2",
        client: {} as SlackEventScope["client"],
      },
    });

    expect(dispatchPreparedSlackMessage).not.toHaveBeenCalled();
  });

  it("dispatches after upgrade when only a pre-change unscoped store record exists", async () => {
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

        await handleFollowUp({
          ts: "1700000001.000003",
          afterContext: () => {
            const runtime = getSlackRuntime();
            setSlackRuntime({
              ...runtime,
              state: {
                ...runtime.state,
                openKeyedStore: (options: OpenKeyedStoreOptions) =>
                  createPluginStateKeyedStoreForTests<{ repliedAt: number }>("slack", {
                    ...options,
                    env: state.env,
                  }),
              },
            } as never);
          },
        });

        expect(dispatchPreparedSlackMessage).toHaveBeenCalledTimes(1);
        expect(dispatchPreparedSlackMessage.mock.calls[0]?.[0]?.ctxPayload.MentionSource).toBe(
          "implicit_thread",
        );
      },
    );
  });
});
