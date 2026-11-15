import { ensureConfiguredAcpBindingReady } from "openclaw/plugin-sdk/acp-binding-runtime";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  resetInboundDedupe,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  registerSessionBindingAdapter,
  testing as bindingTesting,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixClient, type MatrixRawEvent } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import { createMatrixIngressMonitor } from "./ingress.js";

// Provisioning is a separate ACP contract. The real shared dispatch guard and
// registered terminal hook below exercise the configured route's observation.
vi.mock("openclaw/plugin-sdk/acp-binding-runtime", () => ({
  ensureConfiguredAcpBindingReady: vi.fn(async () => ({ ok: true })),
}));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  resetInboundDedupe();
  bindingTesting.resetSessionBindingAdaptersForTests();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it.each([
  "plugin-to-global",
  "configured-stable",
  "configured-to-global",
  "configured-retry",
] as const)(
  "preserves Matrix's prepared owner through the inbound handler: %s",
  async (scenario) => {
    const state = await createOpenClawTestState({ label: "matrix-route-carry" });
    cleanup = () => state.cleanup();
    const roomId = "!route:example.org";
    const senderId = "@sender:example.org";
    const configured = scenario.startsWith("configured");
    const transition = scenario === "plugin-to-global" || scenario === "configured-to-global";
    vi.mocked(ensureConfiguredAcpBindingReady).mockReset().mockResolvedValue({ ok: true });
    const bindings: OpenClawConfig["bindings"] = configured
      ? [
          {
            type: "acp",
            agentId: "configured",
            match: {
              channel: "matrix",
              accountId: "ops",
              peer: { kind: "channel", id: roomId },
            },
          },
        ]
      : undefined;
    const cfg: OpenClawConfig = {
      session: { store: state.path("sessions.json") },
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: state.path("main-workspace") },
          work: { workspace: state.path("work-workspace") },
          configured: { workspace: state.path("configured-workspace") },
        },
        defaults: { skipBootstrap: true, workspace: state.workspaceDir },
      },
      channels: { matrix: { dm: { policy: "open", allowFrom: ["*"] }, groupPolicy: "open" } },
      plugins: { enabled: true, allow: ["matrix"], entries: { matrix: { enabled: true } } },
      acp: { enabled: true, dispatch: { enabled: true } },
      ...(bindings ? { bindings } : {}),
    };
    installMatrixMonitorTestRuntime({ cfg, stateDir: state.stateDir });
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntimeMock(),
      activateGlobalSideEffects: false,
    });
    const cleanupState = cleanup;
    cleanup = async () => {
      await disposePluginRegistryInstances(builder.registry);
      await cleanupState();
    };
    const record = createPluginRecord({ id: "matrix", origin: "bundled", status: "loaded" });
    const api = builder.createApi(record, { config: cfg });
    builder.registry.plugins.push(record);
    defineChannelPluginEntry({
      id: matrixPlugin.id,
      name: matrixPlugin.meta.label,
      description: matrixPlugin.meta.blurb,
      plugin: matrixPlugin,
    }).register(api);
    const terminal = vi.fn<(agentId: string | undefined, sessionKey: string | undefined) => void>();
    api.on(
      "reply_dispatch",
      async (event, context) => {
        terminal(event.ctx.AgentId, event.sessionKey);
        context.recordProcessed("completed", { reason: "synthetic-matrix-route-boundary" });
        context.markIdle("message_completed");
        return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
      { eligibleDispatchKinds: ["agent", "acp"] },
    );
    setActivePluginRegistry(builder.registry);
    initializeGlobalHookRunner(builder.registry);

    const conversation = { channel: "matrix", accountId: "ops", conversationId: roomId };
    const replacement: SessionBindingRecord = {
      bindingId: "matrix-route-owner",
      boundAt: 2,
      targetKind: "session",
      targetSessionKey: "global",
      conversation,
      status: "active",
      metadata: { agentId: "work" },
    };
    let current: SessionBindingRecord | null =
      scenario === "plugin-to-global"
        ? {
            ...replacement,
            boundAt: 1,
            targetSessionKey: "plugin-binding:matrix:source",
            metadata: {
              pluginBindingOwner: "plugin",
              pluginId: "synthetic-owner",
              pluginRoot: state.path("plugin"),
            },
          }
        : null;
    const inspect = vi.fn(() => current);
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => (current ? [current] : []),
      inspectByConversation: inspect,
      resolveByConversation: () => current,
      resolveByConversationAsync: async () => current,
      touch,
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let pause = true;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      runtime,
      isDirectMessage: false,
      resolveAgentRoute: () => ({
        agentId: "main",
        channel: "matrix",
        accountId: "ops",
        sessionKey: "agent:main:matrix:room",
        mainSessionKey: "agent:main:main",
        matchedBy: "binding.account",
      }),
      getMemberDisplayName: async (_room, userId) => {
        if (pause && userId === senderId) {
          pause = false;
          entered.resolve();
          await release.promise;
        }
        return "synthetic sender";
      },
      dispatchInboundMessage: async ({ ctx }) => {
        const dispatcher = createReplyDispatcher({
          deliver: async () => {
            throw new Error("The terminal fixture must not send a provider message");
          },
        });
        try {
          return await withPluginRuntimeRegistryScope(builder.registry, () =>
            dispatchInboundMessage({
              ctx,
              cfg,
              dispatcher,
              replyResolver: async () => {
                throw new Error("Synthetic terminal hook was not selected");
              },
            }),
          );
        } finally {
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        }
      },
    });
    const event = createMatrixTextMessageEvent({
      eventId: `$matrix-route-${scenario}`,
      sender: senderId,
      body: "@room continue",
      mentions: { room: true },
    });
    if (scenario === "configured-retry") {
      pause = false;
      vi.mocked(ensureConfiguredAcpBindingReady).mockResolvedValueOnce({
        ok: false,
        error: "Synthetic backend initialization failure",
      });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const queue = createChannelIngressQueueForTests<{
        version: 1;
        roomId: string;
        event: MatrixRawEvent;
      }>({ channelId: "matrix", accountId: "ops", stateDir: state.stateDir });
      const payload = { version: 1 as const, roomId, event };
      const eventId = "$matrix-route-configured-retry";
      const createIngress = () =>
        createMatrixIngressMonitor({
          accountId: "ops",
          client: new MatrixClient("https://example.org", "synthetic-token"),
          startupMs: 0,
          queue,
          dispatch: handler,
        });
      const firstIngress = createIngress();
      let retryIngress: ReturnType<typeof createIngress> | undefined;
      try {
        await queue.enqueue(eventId, payload, { laneKey: `room:${roomId}` });
        firstIngress.start();
        await firstIngress.waitForIdle();
        expect(terminal).not.toHaveBeenCalled();
        expect(await queue.listPending()).toMatchObject([{ id: eventId, attempts: 1 }]);
        await firstIngress.stop();

        clock.mockReturnValue(now + 2_000);
        retryIngress = createIngress();
        retryIngress.start();
        await retryIngress.waitForIdle();
        expect(terminal).toHaveBeenCalledExactlyOnceWith(
          "configured",
          expect.stringContaining("agent:configured:acp:binding:matrix:ops:"),
        );
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.enqueue(eventId, payload)).toMatchObject({ kind: "completed" });
      } finally {
        await firstIngress.stop();
        await retryIngress?.stop();
      }
      return;
    }
    const receive = () => handler(roomId, event);
    const first = receive();
    const firstOutcome = transition
      ? expect(first).rejects.toThrow("Conversation binding changed while preparing the reply")
      : first;
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error("Message missed the post-route barrier");
      }),
    ]);
    expect(inspect).toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    if (transition) {
      current = replacement;
    }
    release.resolve();
    await firstOutcome;

    if (transition) {
      expect(terminal).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Conversation binding changed while preparing the reply"),
      );
      await receive();
      expect(terminal).toHaveBeenCalledExactlyOnceWith("work", "global");
    } else {
      expect(runtime.error).not.toHaveBeenCalled();
      expect(terminal).toHaveBeenCalledExactlyOnceWith(
        "configured",
        expect.stringContaining("agent:configured:acp:binding:matrix:ops:"),
      );
    }
  },
);
