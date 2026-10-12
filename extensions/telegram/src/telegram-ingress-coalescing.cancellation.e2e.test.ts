// Telegram ingress coalescing regression for a cancelled album turn: durable queue → core
// drain → grammY → media-group buffer. Every coalesced member must be released without
// spending retry budget. Shares the coalescing suite's fixtures and module boundaries.
import path from "node:path";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "openclaw/plugin-sdk/channel-outbound";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdTelegramMediaTimeouts } from "./bot-media-timers.test-support.js";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type { TelegramIngressResources } from "./telegram-ingress-coalescing-fixture.test-support.js";
import { photoUpdate } from "./telegram-ingress-coalescing.test-support.js";

const downstreamTurns = vi.hoisted(() =>
  vi.fn(
    async (
      _ctx: MsgContext,
      _abortSignal?: AbortSignal,
      _turnAdoptionLifecycle?: GetReplyOptions["turnAdoptionLifecycle"],
    ) => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
  ),
);
const inboundTurns = vi.hoisted(() => ({ active: new Set<Promise<void>>() }));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-album-cancel-");
const saveRemoteMedia = vi.hoisted(() =>
  vi.fn(async (params: { filePathHint?: string }) => ({
    id: path.basename(params.filePathHint ?? "photo"),
    path: `/tmp/${path.basename(params.filePathHint ?? "photo.jpg")}`,
    size: 4,
    contentType: "image/jpeg",
  })),
);

// mock-isolation: the suite drives Telegram through a scripted Bot API transport, never the network.
vi.mock("./fetch.js", () => ({
  resolveTelegramApiBase: (apiRoot?: string) => apiRoot ?? "https://api.telegram.org",
  resolveTelegramFetch: (proxyFetch?: typeof fetch) => proxyFetch ?? globalThis.fetch,
  resolveTelegramTransport: (proxyFetch?: typeof fetch) => {
    const fetchImpl = proxyFetch ?? globalThis.fetch;
    return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
  },
  shouldRetryTelegramTransportFallback: () => false,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const turn = runTelegramChannelInboundEventWithHarness(
        actual,
        params,
        async (dispatchParams) =>
          await downstreamTurns(
            dispatchParams.ctx,
            dispatchParams.replyOptions?.abortSignal,
            dispatchParams.replyOptions?.turnAdoptionLifecycle,
          ),
      );
      const settled = turn.then(
        () => {},
        () => {},
      );
      inboundTurns.active.add(settled);
      void settled.then(() => {
        inboundTurns.active.delete(settled);
      });
      return await turn;
    },
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  saveRemoteMedia,
}));

// mock-isolation: real agent runtime resolution would load agent state outside this fixture.
vi.mock("./bot-handlers.agent.runtime.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
}));

// mock-isolation: real model catalog and agent runtime would load state outside this fixture.
vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: vi.fn(() => undefined),
  loadPreparedModelCatalog: vi.fn(async () => []),
  modelSupportsVision: vi.fn(() => false),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

// Preserve production initialization order before the fixture imports those modules.
await import("./bot.js");
await import("openclaw/plugin-sdk/reply-runtime");
await import("./telegram-ingress-drain-factory.js");
await import("./runtime.js");
await import("./runtime.test-support.js");
const { openTelegramIngressQueue, telegramQueueEventId } =
  await import("./telegram-ingress-spool.js");
const { writeTelegramSpooledUpdate } = await import("./telegram-ingress-spool.test-support.js");
const {
  assertSpoolTombstoned,
  createIngressMonitor,
  flushHeldQuietWindow,
  releaseIngressCase,
  resetTelegramIngressRuntime,
  runtimeErrors,
} = await import("./telegram-ingress-coalescing-fixture.test-support.js");

describe("Telegram durable ingress coalescing cancellation", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let activeResources: TelegramIngressResources[];

  beforeEach(async () => {
    stateDir = sessionDirs.make();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    activeResources = [];
    runtimeErrors.length = 0;
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    saveRemoteMedia.mockReset();
    resetTelegramIngressRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await releaseIngressCase(activeResources, inboundTurns.active, stateDir);
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  async function createMonitor() {
    const resources = await createIngressMonitor(stateDir);
    activeResources.push(resources);
    return resources;
  }

  it("keeps every aged album member recoverable when the coalesced turn is cancelled", async () => {
    const first = photoUpdate({ updateId: 1_101, messageId: 1, caption: "Two photo album" });
    const second = photoUpdate({ updateId: 1_102, messageId: 2 });
    const eventIds = [telegramQueueEventId(1_101), telegramQueueEventId(1_102)];
    const queue = openTelegramIngressQueue({ stateDir });
    // Each member was received long before the dead-letter age floor, with one try left.
    for (const update of [first, second]) {
      await writeTelegramSpooledUpdate({ stateDir, update, now: 1 });
      for (let attempt = 1; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim(telegramQueueEventId(update.update_id));
        if (!claim) {
          throw new Error(`Expected to seed album member ${update.update_id}`);
        }
        await queue.release(claim, { lastError: "prior failure", releasedAt: 1 });
      }
    }
    const agedMembers = eventIds.map((id) =>
      expect.objectContaining({
        id,
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
        lastError: "prior failure",
      }),
    );
    downstreamTurns
      .mockImplementationOnce(async (_ctx, _abortSignal, lifecycle) => {
        lifecycle?.onDeferred?.();
        // The reply lane settles a cleared queued turn through onCancelled and
        // falls back to abandonment only when the lifecycle cannot cancel.
        await (lifecycle?.onCancelled ? lifecycle.onCancelled() : lifecycle?.onAbandoned?.());
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      })
      .mockImplementationOnce(async (_ctx, _abortSignal, lifecycle) => {
        await lifecycle?.onAdopted();
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      });
    const albumTimers = holdTelegramMediaTimeouts(40);
    const { monitor, telegramTransport } = await createMonitor();

    try {
      monitor.start();
      await monitor.waitForIdle();
      await vi.waitFor(async () =>
        expect((await queue.listClaims()).map((claim) => claim.id).toSorted()).toEqual(eventIds),
      );
      flushHeldQuietWindow(albumTimers, 40);
      await vi.waitFor(
        () => {
          expect(downstreamTurns, runtimeErrors.map(String).join("\n")).toHaveBeenCalledTimes(1);
        },
        { timeout: 5_000, interval: 5 },
      );

      // Cancellation spends no member's budget: both rows return to the drain
      // with their prior retry facts and are buffered into the album again.
      await vi.waitFor(async () => {
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect((await queue.listClaims()).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
          agedMembers,
        );
      });
      await monitor.waitForIdle();
      flushHeldQuietWindow(albumTimers, 40);
      await monitor.waitForDeferredClaims();
      await vi.waitFor(() => expect(downstreamTurns).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
      await assertSpoolTombstoned({ stateDir, updateIds: [1_101, 1_102] });
    } finally {
      albumTimers.mockRestore();
      await monitor.stop();
      await telegramTransport.close();
    }
  });
});
