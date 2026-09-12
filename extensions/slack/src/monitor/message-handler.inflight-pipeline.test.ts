import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, describe, expect, it, vi } from "vitest";
import { clearSlackThreadParticipationCache } from "../sent-thread-cache.js";
import type { SlackMessageEvent } from "../types.js";
import {
  createInflightSlackPipeline,
  type InflightDispatchParams,
} from "./message-handler.inflight-pipeline.test-helpers.js";
import { getSlackSessionRuns } from "./session-run-targets.js";

type Pipeline = ReturnType<typeof createInflightSlackPipeline>;
const coreTurn = vi.hoisted(() => ({
  run: undefined as
    | ((params: InflightDispatchParams) => ReturnType<Pipeline["dispatchCore"]>)
    | undefined,
}));

// Only the core agent turn is scripted. Handler/debounce, prepare, dispatch,
// publisher registration, final sender, and state-store writes remain real.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    dispatchChannelInboundTurn: (params: InflightDispatchParams) => {
      if (!coreTurn.run) {
        throw new Error("Slack integrated turn fixture is not initialized");
      }
      return coreTurn.run(params);
    },
  };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/channel-inbound");
  vi.resetModules();
});

const ROOT_TS = "1700000000.000001";
const FOLLOWUP_TS = "1700000001.000001";
const FINAL_TEXT = "The revised report is ready.";
const rootMessage = (): SlackMessageEvent => ({
  type: "message",
  channel: "C123",
  channel_type: "channel",
  user: "U1",
  ts: ROOT_TS,
  text: "<@B1> Check the report",
});
const followupMessage = (overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: "message",
  channel: "C123",
  channel_type: "channel",
  user: "U1",
  ts: FOLLOWUP_TS,
  text: "Use the revised total",
  thread_ts: ROOT_TS,
  parent_user_id: "U1",
  ...overrides,
});
const liveRuns = (pipeline: Pipeline) =>
  getSlackSessionRuns(pipeline.ctx, { channelId: "C123", threadTs: ROOT_TS });
const visibleCalls = (pipeline: Pipeline) =>
  pipeline.apiCalls.filter((call) =>
    ["chat.postMessage", "chat.startStream", "chat.update"].includes(call.method),
  );

async function withPipeline(
  test: (pipeline: Pipeline) => Promise<void>,
  threadParticipation = true,
) {
  await withOpenClawTestState(
    { label: "slack-inflight-pipeline", layout: "state-only" },
    async (state) => {
      clearSlackThreadParticipationCache();
      const pipeline = createInflightSlackPipeline({
        stateDir: state.stateDir,
        threadParticipation,
      });
      coreTurn.run = pipeline.dispatchCore;
      try {
        await test(pipeline);
      } finally {
        await pipeline.close();
        coreTurn.run = undefined;
      }
    },
  );
}

describe("Slack handler in-flight follow-up pipeline", () => {
  it("admits a same-thread human follow-up before first output and delivers its answer once", async () => {
    await withPipeline(async (pipeline) => {
      const root = await pipeline.receive(rootMessage(), "app_mention");
      expect(root.turn).toBeDefined();
      if (!root.turn) {
        throw new Error("Mentioned root was not admitted");
      }
      expect(liveRuns(pipeline)).toHaveLength(1);
      expect(visibleCalls(pipeline)).toEqual([]);
      expect(await pipeline.persistedParticipant(ROOT_TS)).toBe(false);

      const visibleBeforeFollowup = visibleCalls(pipeline).length;
      const followup = await pipeline.receive(followupMessage());
      expect(followup.turn).toBeDefined();
      if (!followup.turn) {
        throw new Error("In-flight follow-up was not admitted");
      }
      expect(followup.turn.params.ctxPayload).toMatchObject({
        MentionSource: "implicit_thread",
        MessageSid: FOLLOWUP_TS,
        SessionKey: root.turn.params.ctxPayload.SessionKey,
      });
      expect(visibleCalls(pipeline)).toEqual([]);
      expect(await pipeline.persistedParticipant(ROOT_TS)).toBe(false);
      await root.turn.finish();
      await root.completion;
      expect(liveRuns(pipeline)).toHaveLength(1);
      expect(liveRuns(pipeline)[0]?.isActive()).toBe(true);

      await followup.turn.finish(FINAL_TEXT);
      await followup.completion;
      expect(visibleCalls(pipeline)).toEqual([
        { method: "chat.postMessage", channel: "C123", threadTs: ROOT_TS, text: FINAL_TEXT },
      ]);
      expect(liveRuns(pipeline)).toEqual([]);
      expect(await pipeline.persistedParticipant(ROOT_TS)).toBe(true);
      expect(pipeline.runtimeErrors).toEqual([]);
      if (process.env.OPENCLAW_DELIVERY_PROOF === "1") {
        process.stdout.write(
          `${JSON.stringify({
            kind: "in-process Slack handler integration",
            liveSlack: false,
            gatewayProcess: false,
            headSha: process.env.OPENCLAW_DELIVERY_PROOF_SHA ?? "",
            entry: "createSlackMessageHandler",
            harness: "extensions/slack/src/monitor/message-handler.inflight-pipeline.test.ts",
            visibleBeforeFollowup,
            mockedBoundaries: ["core agent turn", "Slack Web API"],
            followup: {
              messageSid: followup.turn.params.ctxPayload.MessageSid,
              mentionSource: followup.turn.params.ctxPayload.MentionSource,
            },
            finalWireCalls: visibleCalls(pipeline),
            remainingPublishers: liveRuns(pipeline).length,
          })}\n`,
        );
      }
    });
  });

  it.each(["other-thread", "explicit-mention-policy"])(
    "keeps %s follow-ups gated while root work is active",
    async (boundary) => {
      await withPipeline(async (pipeline) => {
        const root = await pipeline.receive(rootMessage(), "app_mention");
        expect(root.turn).toBeDefined();
        if (!root.turn) {
          throw new Error("Mentioned root was not admitted");
        }
        expect(liveRuns(pipeline)).toHaveLength(1);
        const followup = await pipeline.receive(
          followupMessage(boundary === "other-thread" ? { thread_ts: "1700000000.000002" } : {}),
        );
        expect(followup.turn).toBeUndefined();
        await followup.completion;
        expect(pipeline.turns).toHaveLength(1);
        expect(visibleCalls(pipeline)).toEqual([]);
        await root.turn.finish();
        await root.completion;
        expect(liveRuns(pipeline)).toEqual([]);
        expect(await pipeline.persistedParticipant(ROOT_TS)).toBe(false);
      }, boundary !== "explicit-mention-policy");
    },
  );

  it("releases a failed root without persisting participation or admitting a later unmentioned input", async () => {
    await withPipeline(async (pipeline) => {
      const root = await pipeline.receive(rootMessage(), "app_mention");
      expect(root.turn).toBeDefined();
      if (!root.turn) {
        throw new Error("Mentioned root was not admitted");
      }
      expect(liveRuns(pipeline)).toHaveLength(1);
      const failure = new Error("Synthetic agent turn failed before replying");
      root.turn.fail(failure);
      await expect(root.completion).rejects.toBe(failure);
      expect(liveRuns(pipeline)).toEqual([]);
      expect(visibleCalls(pipeline)).toEqual([]);
      expect(await pipeline.persistedParticipant(ROOT_TS)).toBe(false);
      clearSlackThreadParticipationCache();
      const later = await pipeline.receive(followupMessage());
      expect(later.turn).toBeUndefined();
      await later.completion;
      expect(pipeline.turns).toHaveLength(1);
      expect(visibleCalls(pipeline)).toEqual([]);
      expect(pipeline.runtimeErrors.length).toBeGreaterThan(0);
    });
  });
});
