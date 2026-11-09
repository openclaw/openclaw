import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createMSTeamsIngress } from "../msteams-ingress.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  createDebounceControl,
  createMessageHandlerDeps,
  createTurnContext,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const openDM: OpenClawConfig = {
  channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
};

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function createLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
  } satisfies MSTeamsIngressLifecycle;
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return createTurnContext(activity, { sent: "sent", updated: "updated" });
}

function directActivity(id: string, text: string): MSTeamsTurnContext["activity"] {
  return buildChannelActivity({
    id,
    text,
    conversation: { id: "dm-conversation", conversationType: "personal" },
    channelData: {},
    entities: [],
  }) as MSTeamsTurnContext["activity"];
}

function createHandler(cfg = openDM, createDebouncer = createInboundDebouncer, debounceMs = 40) {
  const { deps } = createMessageHandlerDeps(cfg, {
    createInboundDebouncer: createDebouncer,
    resolveInboundDebounceMs: vi.fn(() => debounceMs),
  });
  return createMSTeamsMessageHandler(deps);
}
function expectAdopted(lifecycle: ReturnType<typeof createLifecycle>) {
  expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1);
  expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
}

describe("Microsoft Teams drain claim ownership", () => {
  beforeEach(() => {
    dispatch.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it.each(["batched", "gated", "html"])("settles %s claims once", async (mode) => {
    vi.useFakeTimers();
    const clock = createDebounceControl();
    const gated = mode === "gated";
    const html = mode === "html";
    const mentions = [
      { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id" } },
      { type: "mention", text: "<at>Other User</at>", mentioned: { id: "other-user-id" } },
    ];
    const cfg: OpenClawConfig = gated
      ? { channels: { msteams: { groupPolicy: "open", requireMention: true } } }
      : openDM;
    const messages = gated
      ? [buildChannelActivity({ id: "gated", text: "not for the bot", entities: [] })]
      : html
        ? [
            {
              ...directActivity("html", ""),
              entities: mentions,
              attachments: [
                {
                  contentType: "TEXT/HTML",
                  content:
                    "<at>Bot</at><p>Use x &lt; 5 &copy;; literal &lt;at&gt;Alice&lt;/at&gt;; " +
                    "ask <at>Other User</at>; once &amp;lt;tag&amp;gt; " +
                    '<img src="https://statics.teams.cdn.office.net/emoji/smile.png" alt="🙂"></p>',
                },
              ],
            },
          ]
        : [
            {
              ...directActivity("first", "<at>Bot</at> part one <at>Other User</at>"),
              entities: mentions,
            },
            directActivity("second", "part two <at>Unidentified User</at>"),
          ];
    const handler = createHandler(cfg, clock.createDebouncer);
    const claims = messages.map(() => createLifecycle());
    try {
      for (const [i, message] of messages.entries()) {
        expect(await handler(context(message), claims[i])).toEqual({ kind: "deferred" });
      }
      if (html) {
        expect(dispatch).toHaveBeenCalledTimes(1);
      }
      await clock.flush(40);
      expect(dispatch).toHaveBeenCalledTimes(gated ? 0 : 1);
      for (const claim of claims) {
        expectAdopted(claim);
      }
      if (!gated) {
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
          ctx: {
            BodyForAgent: html
              ? "Use x < 5 ©; literal <at>Alice</at>; ask @Other User; once &lt;tag&gt; 🙂"
              : "part one @Other User\npart two @Unidentified User",
          },
          replyOptions: { turnAdoptionLifecycle: { admission: "exclusive" } },
        });
      }
    } finally {
      await clock.flush(40);
    }
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "msteams",
      accountId: "test-app",
      stateDir,
    });
    const incoming = directActivity("activity-abandon", "retry me");
    await queue.enqueue(
      "activity-abandon",
      { version: 1, receivedAt: now - 2 * 24 * 60 * 60_000, rawActivity: JSON.stringify(incoming) },
      { laneKey: "dm-conversation", receivedAt: now - 2 * 24 * 60 * 60_000 },
    );
    const dispatchMock = dispatch;
    const priorImplementation = dispatchMock.getMockImplementation();
    dispatchMock.mockRejectedValue(new Error("Microsoft Teams dispatch failed before adoption"));

    let stopCurrent: (() => Promise<void>) | undefined;
    type Pending = Awaited<ReturnType<typeof queue.listPending>>[number];
    const restart = async (
      timestamp: number,
      expected: number | Pending,
      dispatches: number,
      replay = true,
    ) => {
      vi.setSystemTime(timestamp);
      const clock = createDebounceControl();
      const handler = createHandler(openDM, clock.createDebouncer);
      const ingress = createMSTeamsIngress({
        accountId: "test-app",
        queue,
        runtime: { error: vi.fn(), log: vi.fn() },
        dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
      });
      const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
      if (monitorResult?.type !== "return") {
        throw new Error("Expected the Microsoft Teams ingress and debounce owners");
      }
      const monitor = monitorResult.value;
      stopCurrent = async () => {
        await monitor.pause();
        await monitor.waitForIdle();
        await clock.flush(40);
        await ingress.stop();
      };
      ingress.start();
      if (replay) {
        await ingress.accept(incoming);
      }
      await monitor.waitForIdle();
      if (typeof expected === "number") {
        await clock.flush(40);
      }
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toEqual([
        typeof expected === "number"
          ? expect.objectContaining({
              id: "activity-abandon",
              attempts: expected,
              lastAttemptAt: expect.any(Number),
              lastError: "turn-abandoned",
            })
          : expected,
      ]);
      expect(dispatchMock).toHaveBeenCalledTimes(dispatches);
      const observed = pending[0];
      if (!observed || observed.lastAttemptAt === undefined) {
        throw new Error("Missing Microsoft Teams retry timestamp");
      }
      await ingress.stop();
      return { ...observed, lastAttemptAt: observed.lastAttemptAt };
    };

    try {
      const firstAttempt = await restart(now, 1, 1, false);
      await restart(firstAttempt.lastAttemptAt + 999, firstAttempt, 1);
      const secondAttempt = await restart(firstAttempt.lastAttemptAt + 1_001, 2, 2);

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("activity-abandon", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Microsoft Teams seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }
      const thresholdAttempt = await restart(
        secondAttempt.lastAttemptAt + 64_001,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        3,
      );

      const beyondAttempt = await restart(
        thresholdAttempt.lastAttemptAt + 128_001,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1,
        4,
      );
      await restart(beyondAttempt.lastAttemptAt + 1_000, beyondAttempt, 4);
    } finally {
      try {
        await stopCurrent?.();
      } finally {
        vi.useRealTimers();
        dispatchMock.mockReset();
        if (priorImplementation) {
          dispatchMock.mockImplementation(priorImplementation);
        }
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    }
  });
});
