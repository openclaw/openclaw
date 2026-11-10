import { afterEach, expect, it, vi } from "vitest";
import type { ChannelHeartbeatAdapter } from "../../../channels/plugins/types.adapters.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import { createLifecycleTypingManager } from "../../../gateway/lifecycle-typing.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-lifecycle-runtime-context.js";
import { createMockGatewayLifecycleRuntime } from "../../../gateway/server-lifecycle-runtime.test-support.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../../utils/delivery-context.shared.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { operatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../gateway/server-lifecycle-runtime-context.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["terminal", "reset", "rebind", "already rebound", "revoked", "policy", "quiet"] as const)(
  "scopes detached Telegram typing through %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { store: state.path("sessions.json") },
        agents: {
          defaults: {
            typingIntervalSeconds: 1,
            typingMode: scenario === "policy" ? "never" : "instant",
          },
        },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(cfg);
      vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
      vi.mocked(bindGatewayLifecycleRequest).mockReturnValue(callGateway);
      vi.mocked(onAgentEvent).mockReturnValue(() => {});
      const sends: Array<Parameters<NonNullable<ChannelHeartbeatAdapter["sendTypingGuarded"]>>[0]> =
        [];
      let pendingSend: Promise<void> | undefined;
      const enteredSend = createDeferredCore();
      const typing = createLifecycleTypingManager({
        getConfig: () => cfg,
        isAvailable: () => true,
        resolveAdapter: async () => ({
          sendTypingGuarded: async (target) => {
            if (pendingSend) {
              enteredSend.resolve();
              await pendingSend;
            }
            target.assertPlatformSendAuthorized?.();
            sends.push(target);
          },
        }),
      });
      const context = createContext();
      context.lifecycleRuntime = createMockGatewayLifecycleRuntime({
        startTyping: (params) => typing.start(params),
      });
      const fixture = operatorFixture("typing-source", true, context);
      const source = { channel: "telegram", accountId: "work", to: "-100123", threadId: 7 };
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        for (const [runId, origin] of [
          ["one", source],
          ["two", source],
          ["other", { ...source, accountId: "personal", to: "456", threadId: 9 }],
        ] as const) {
          const requesterId = runId === "two" ? "one" : runId;
          const requesterSessionKey = `agent:main:telegram:${requesterId}`;
          if (runId !== "two") {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: requesterSessionKey, storePath: cfg.session.store },
              {
                sessionId: `parent-${requesterId}`,
                updatedAt: Date.now(),
                delivery: normalizeSessionDeliveryState({
                  context:
                    scenario === "already rebound" && runId === "one"
                      ? { ...origin, to: "forbidden" }
                      : origin,
                }),
              },
            );
          }
          await withPluginRuntimeGatewayRequestScope(
            { ...fixture, isWebchatConnect: () => false },
            () =>
              registerSubagentRun({
                runId,
                childAgentId: "main",
                childSessionKey: `agent:main:subagent:${runId}`,
                sessionEntry: { sessionId: `child-${runId}` },
                requesterSessionKey,
                requesterAgentId: "main",
                requesterDisplayKey: "source",
                requesterOrigin: origin,
                completionRequesterSessionId: `parent-${requesterId}`,
                gatewayContextResolver: fixture.resolveGatewayContext,
                expectsCompletionMessage: scenario !== "quiet",
                task: "detached work",
                cleanup: "keep",
              }),
          );
        }
        await vi.dynamicImportSettled();
        if (scenario === "already rebound") {
          expect(sends.map(({ to }) => to)).toEqual(["456"]);
          await vi.advanceTimersByTimeAsync(1000);
          expect(sends.map(({ to }) => to)).toEqual(["456", "456"]);
          return;
        }
        if (scenario === "policy" || scenario === "quiet") {
          await vi.advanceTimersByTimeAsync(3000);
          expect(sends).toEqual([]);
          expect(vi.getTimerCount()).toBe(0);
          return;
        }
        expect(sends.map(({ accountId, to, threadId }) => ({ accountId, to, threadId }))).toEqual([
          { accountId: "work", to: "-100123", threadId: 7 },
          { accountId: "work", to: "-100123", threadId: 7 },
          { accountId: "personal", to: "456", threadId: 9 },
        ]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sends).toHaveLength(6);
        if (scenario !== "terminal") {
          sends.length = 0;
          const release = createDeferredCore();
          pendingSend = release.promise;
          const tick = vi.advanceTimersByTimeAsync(1000);
          await enteredSend.promise;
          if (scenario === "revoked") {
            fixture.revoked.abort();
          } else {
            await upsertSessionEntryCore(
              {
                agentId: "main",
                sessionKey: "agent:main:telegram:one",
                storePath: cfg.session.store,
              },
              scenario === "reset"
                ? { sessionId: "replacement" }
                : {
                    delivery: normalizeSessionDeliveryState({
                      context: {
                        ...source,
                        to: "forbidden",
                        accountId: "forbidden",
                        threadId: 99,
                      },
                    }),
                  },
            );
          }
          release.resolve();
          await tick;
          expect(sends.map(({ to }) => to)).toEqual(scenario === "revoked" ? [] : ["456"]);
          return;
        }
        for (const [runId, outcome] of [
          ["one", { status: "ok" }],
          ["two", { status: "error", error: "failed" }],
        ] as const) {
          await mutateSubagentRuns([runId], (rows) => {
            const row = rows.get(runId)!;
            return {
              value: undefined,
              postimages: new Map([
                [
                  runId,
                  {
                    ...row,
                    execution: {
                      ...row.execution,
                      status: "terminal",
                      endedAt: Date.now(),
                      outcome,
                    },
                  },
                ],
              ]),
            };
          });
          sends.length = 0;
          await vi.advanceTimersByTimeAsync(1000);
          expect(sends.map(({ to }) => to)).toEqual(runId === "one" ? ["-100123", "456"] : ["456"]);
        }
        await mutateSubagentRuns(["other"], (rows) => {
          const row = rows.get("other")!;
          return {
            value: undefined,
            postimages: new Map([
              ["other", { ...row, killIntent: { requestedAt: Date.now(), reason: "killed" } }],
            ]),
          };
        });
        sends.length = 0;
        await vi.advanceTimersByTimeAsync(3000);
        expect(sends).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        fixture.revoked.abort();
        typing.close();
      }
    });
  },
);
