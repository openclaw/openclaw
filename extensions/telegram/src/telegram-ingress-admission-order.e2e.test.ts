// Telegram ingress admission order: durable queue → core drain → grammY → inbound buffers.
// A released lane lets a later sender reach its buffer while an earlier sender's
// burst is still debouncing; reply admission must still follow spool order.
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type { TelegramIngressResources } from "./telegram-ingress-coalescing-fixture.test-support.js";
import {
  forwardedTextUpdate,
  groupSenders,
  holdForwardWindow,
  inSharedGroup,
  textUpdate,
} from "./telegram-ingress-coalescing.test-support.js";

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
const activeTurns = vi.hoisted(() => new Set<Promise<void>>());
// Counts reply turns that reached the turn kernel's ingress admission wait.
const admissionWaits = vi.hoisted(() => ({ started: 0 }));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-admission-order-");

vi.mock("./fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.js")>()),
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
      const resolveTurn = params.adapter.resolveTurn;
      const observed = {
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (...args: Parameters<typeof resolveTurn>) => {
            const plan = (await resolveTurn(...args)) as Awaited<ReturnType<typeof resolveTurn>> & {
              replyOptions?: { turnAdoptionLifecycle?: GetReplyOptions["turnAdoptionLifecycle"] };
            };
            const lifecycle = plan.replyOptions?.turnAdoptionLifecycle;
            const admissionTurn = lifecycle?.admissionTurn;
            if (!lifecycle || !admissionTurn) {
              return plan;
            }
            const wait = async () => {
              admissionWaits.started += 1;
              await admissionTurn.wait();
            };
            return {
              ...plan,
              replyOptions: {
                ...plan.replyOptions,
                turnAdoptionLifecycle: { ...lifecycle, admissionTurn: { wait } },
              },
            };
          },
        },
      };
      const turn = runTelegramChannelInboundEventWithHarness(actual, observed, (dispatchParams) =>
        downstreamTurns(
          dispatchParams.ctx,
          dispatchParams.replyOptions?.abortSignal,
          dispatchParams.replyOptions?.turnAdoptionLifecycle,
        ),
      );
      const settled = turn.then(
        () => {},
        () => {},
      );
      activeTurns.add(settled);
      void settled.then(() => activeTurns.delete(settled));
      return await turn;
    },
  };
});

vi.mock("./bot-handlers.agent.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-handlers.agent.runtime.js")>()),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-message-dispatch.agent.runtime.js")>()),
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
const {
  assertSpoolTombstoned,
  createDownstreamTurnFixture,
  createIngressMonitor,
  releaseIngressCase,
  resetTelegramIngressRuntime,
  runtimeErrors,
} = await import("./telegram-ingress-coalescing-fixture.test-support.js");
const { holdFirstDownstreamTurn } = createDownstreamTurnFixture(downstreamTurns);

describe("Telegram durable ingress admission order", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let activeResources: TelegramIngressResources[];

  beforeEach(() => {
    stateDir = sessionDirs.make();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    activeResources = [];
    runtimeErrors.length = 0;
    admissionWaits.started = 0;
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    resetTelegramIngressRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await releaseIngressCase(activeResources, activeTurns, stateDir);
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("keeps a later sender behind a buffered forward until that batch reaches reply admission", async () => {
    const { releaseHead, headFinished } = holdFirstDownstreamTurn();
    const resources = await createIngressMonitor(stateDir);
    activeResources.push(resources);
    const { monitor } = resources;
    const forwardWindow = holdForwardWindow();
    try {
      monitor.start();
      const forward = forwardedTextUpdate({ updateId: 1_601, messageId: 1, text: "Ada forward" });
      await monitor.admit(inSharedGroup(forward, groupSenders.ada));
      await monitor.waitForIdle();
      // Bo's plain text is not debounced, so it used to reach reply admission
      // while Ada's forward still sat in its quiet window.
      const reply = textUpdate({ updateId: 1_602, messageId: 2, text: "Bo reply" });
      await monitor.admit(inSharedGroup(reply, groupSenders.bo));
      // Ada's forward is still held, so the only turn that can reach the kernel is Bo's.
      await vi.waitFor(() => expect(admissionWaits.started).toBe(1), { timeout: 5_000 });
      expect(downstreamTurns).not.toHaveBeenCalled();

      forwardWindow.flush();
      // Ada's turn is only queued behind an active run; queued admission must
      // release Bo without waiting for adoption.
      await vi.waitFor(() => expect(downstreamTurns).toHaveBeenCalledTimes(2));
      expect(downstreamTurns.mock.calls.map(([turn]) => turn.RawBody)).toEqual([
        "Ada forward",
        "Bo reply",
      ]);
      releaseHead.resolve();
      await headFinished.promise;
      await monitor.waitForDeferredClaims();
      await assertSpoolTombstoned({ stateDir, updateIds: [1_601, 1_602] });
      expect(runtimeErrors).toEqual([]);
    } finally {
      releaseHead.resolve();
      forwardWindow.restore();
    }
  });

  it("lets a later sender's control command skip a buffered forward", async () => {
    const { monitor } = await createIngressMonitor(stateDir).then((resources) => {
      activeResources.push(resources);
      return resources;
    });
    const forwardWindow = holdForwardWindow();
    try {
      monitor.start();
      const forward = forwardedTextUpdate({ updateId: 1_701, messageId: 1, text: "Ada forward" });
      await monitor.admit(inSharedGroup(forward, groupSenders.ada));
      await monitor.waitForIdle();
      const stop = textUpdate({ updateId: 1_702, messageId: 2, text: "/stop" });
      await monitor.admit(inSharedGroup(stop, groupSenders.bo));
      await vi.waitFor(() => expect(downstreamTurns).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(downstreamTurns.mock.calls[0]?.[0].RawBody).toBe("/stop");
      expect(admissionWaits.started).toBe(0);

      forwardWindow.flush();
      await vi.waitFor(() => expect(downstreamTurns).toHaveBeenCalledTimes(2));
      await monitor.waitForDeferredClaims();
      await assertSpoolTombstoned({ stateDir, updateIds: [1_701, 1_702] });
    } finally {
      forwardWindow.restore();
    }
  });
});
