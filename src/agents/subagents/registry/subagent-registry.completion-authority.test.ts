import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-recovery-runtime-context.js";
import { onAgentEvent, rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  adoptSubagentRunForRequesterTurn,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry.store.sqlite.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../gateway/server-recovery-runtime-context.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });
vi.mock("./subagent-registry.store.sqlite.js", { spy: true });

function registration(
  runId: string,
  overrides: Partial<Parameters<typeof registerSubagentRun>[0]> = {},
): Parameters<typeof registerSubagentRun>[0] {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "result",
    cleanup: "keep",
    expectsCompletionMessage: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
  vi.mocked(bindGatewayLifecycleRequest).mockReturnValue(callGateway);
  vi.mocked(onAgentEvent).mockReturnValue(() => {});
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  vi.mocked(callGateway).mockReset();
  vi.mocked(bindGatewayLifecycleRequest).mockReset();
  vi.mocked(onAgentEvent).mockReset();
  vi.mocked(saveSubagentRegistryChangesToSqlite).mockReset();
});

describe("registered completion source custody", () => {
  it.each([false, true])(
    "publishes ordinary registration only after a current worker commit (caller revoked: %s)",
    async (revoke) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.path("sessions.json") } };
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const runId = "worker-registration";
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const execute = stateWorker.runOpenClawStateWorkerOperation;
        const held = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementationOnce(async (owner, run, options) => {
            entered.resolve();
            await release.promise;
            return execute(owner, run, options);
          });
        let current = true;
        let pending: Promise<void> | undefined;
        try {
          pending = Promise.resolve(
            registerSubagentRun(registration(runId), {
              persistence: "worker",
              assertCurrent: () => {
                if (!current) {
                  throw new Error("requester retired before registry commit");
                }
              },
            }),
          );
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Registration completed without entering worker persistence");
            }),
          ]);
          expect(subagentRuns.has(runId)).toBe(false);
          expect(callGateway).not.toHaveBeenCalled();
          current = !revoke;
          release.resolve();
          if (revoke) {
            await expect(pending).rejects.toThrow("requester retired before registry commit");
            expect(subagentRuns.has(runId)).toBe(false);
            expect(callGateway).not.toHaveBeenCalled();
          } else {
            await pending;
            expect(subagentRuns.get(runId)).toMatchObject({
              execution: { status: "running" },
              expectsCompletionMessage: true,
            });
            expect(callGateway).toHaveBeenCalledWith(
              expect.objectContaining({
                method: "agent.wait",
                params: expect.objectContaining({ runId }),
              }),
            );
            const accepted = subagentRuns.get(runId);
            expect(accepted?.childAgentId).toBeUndefined();
            await registerSubagentRun(registration(runId, { childAgentId: "MAIN" }), {
              persistence: "worker",
            });
            expect(subagentRuns.get(runId)).toBe(accepted);
            expect(() =>
              registerSubagentRun(registration(runId, { childAgentId: "research" }), {
                persistence: "worker",
              }),
            ).toThrow("Subagent registration child agent disagrees with its session key.");
            expect(callGateway).toHaveBeenCalledTimes(1);
          }
        } finally {
          release.resolve();
          await pending?.catch(() => {});
          held.mockRestore();
        }
      });
    },
  );

  it("retains raw child ownership, including unknown legacy ownership, on registration replay", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const originalConfig = { session: { store: state.path("original.sqlite") } };
      for (const childAgentId of [undefined, "research"]) {
        vi.mocked(config.getRuntimeConfig).mockReturnValue(originalConfig);
        const runId = childAgentId ?? "legacy";
        const params = registration(runId, { childSessionKey: "global", childAgentId });
        await registerSubagentRun(params);
        expect(subagentRuns.get(runId)?.childAgentId).toBe(childAgentId);
        vi.mocked(config.getRuntimeConfig).mockReturnValue({
          session: { store: state.path("replacement.sqlite") },
        });
        await registerSubagentRun({ ...params, childAgentId: "main" });
        expect(subagentRuns.get(runId)?.childAgentId).toBe(childAgentId);
      }
    });
  });

  it.each([
    "admission",
    "lifecycle",
    "replacement",
    "retired child replacement",
    "failed child replacement",
    "unrelated child",
    "store",
    "source callback",
  ] as const)(
    "preserves the selected registration owner when %s changes during preparation",
    async (changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        let cfg: OpenClawConfig = { session: { store: state.path("original.sqlite") } };
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
        context.resolveGatewayContext = () => context;
        const client = createOperatorClient({
          profileName: "preparing-registration",
          scopes: ["operator.write"],
        });
        const sourceController = new AbortController();
        client.internal = {
          operatorAccessAuthority: {
            signal: sourceController.signal,
            assertCurrent: () => sourceController.signal.throwIfAborted(),
          },
        };
        const requesterSessionKey = "agent:main:main";
        const originalPath = resolvePhysicalSessionStorePath(
          { sessionKey: requesterSessionKey, agentId: "main" },
          cfg,
        );
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        let active = true;
        const capture = operatorCapture.captureGatewayOperatorRunAuthority;
        let captured: Awaited<ReturnType<typeof capture>>;
        const held = vi
          .spyOn(operatorCapture, "captureGatewayOperatorRunAuthority")
          .mockImplementationOnce(async (...args) => {
            captured = await capture(...args);
            entered.resolve();
            await resume.promise;
            return captured;
          });
        const runId = "prepared-child";
        const childSessionKey = "agent:main:subagent:prepared-child";
        const runtimeConfig = vi.mocked(config.getRuntimeConfig).mockImplementation(() => cfg);
        const pending = withPluginRuntimeGatewayRequestScope(
          { client, context, isWebchatConnect: () => false },
          () =>
            registerSubagentRun(registration(runId), {
              assertCurrent: () => {
                if (!active) {
                  throw new Error("launch closed");
                }
                if (changed === "source callback") {
                  sourceController.abort(new Error("source closed by admission callback"));
                }
              },
            }),
        );
        const settled = Promise.allSettled([pending]);
        let replacement = subagentRuns.get(runId);
        try {
          await entered.promise;
          if (changed === "admission") {
            active = false;
          } else if (changed === "lifecycle") {
            rotateAgentEventLifecycleGeneration();
          } else if (changed === "replacement") {
            await registerSubagentRun(
              registration(runId, { task: "replacement", expectsCompletionMessage: false }),
            );
            replacement = subagentRuns.get(runId);
            expect(replacement).toBeDefined();
          } else if (
            changed === "retired child replacement" ||
            changed === "failed child replacement" ||
            changed === "unrelated child"
          ) {
            const registerNewChild = async () => {
              await registerSubagentRun(
                registration("newer-child", {
                  childSessionKey:
                    changed === "unrelated child"
                      ? "agent:main:subagent:unrelated"
                      : childSessionKey,
                  task: "newer child",
                  expectsCompletionMessage: false,
                }),
              );
            };
            if (changed === "failed child replacement") {
              vi.mocked(saveSubagentRegistryChangesToSqlite).mockImplementationOnce(() => {
                throw new Error("replacement write refused");
              });
              await expect(registerNewChild()).rejects.toThrow("replacement write refused");
              expect(subagentRuns.has("newer-child")).toBe(false);
            } else {
              await registerNewChild();
              expect(subagentRuns.get("newer-child")).toBeDefined();
              if (changed === "retired child replacement") {
                releaseSubagentRun("newer-child");
              }
            }
          } else if (changed === "store") {
            cfg = { session: { store: state.path("replacement.sqlite") } };
            expect(
              resolvePhysicalSessionStorePath(
                { sessionKey: requesterSessionKey, agentId: "main" },
                cfg,
              ),
            ).not.toBe(originalPath);
          }
          resume.resolve();
          if (
            changed === "store" ||
            changed === "unrelated child" ||
            changed === "failed child replacement"
          ) {
            await pending;
            expect(subagentRuns.get(runId)?.requesterStorePath).toBe(originalPath);
            expect(subagentRuns.get(runId)?.controllerStorePath).toBe(originalPath);
            expect(subagentRuns.get(runId)?.childAgentId).toBeUndefined();
            releaseSubagentRun(runId);
          } else {
            await expect(pending).rejects.toThrow(
              /launch closed|lifecycle changed|owner changed|continuation authority/,
            );
            expect(subagentRuns.get(runId)).toBe(replacement);
          }
          expect(captured?.authority.assertCurrent).toThrow();
        } finally {
          resume.resolve();
          await settled;
          held.mockRestore();
          runtimeConfig.mockReset();
          resetSubagentRegistryForTests({ persist: false });
        }
      });
    },
  );

  it.each([
    "settle",
    "revoke",
    "gateway-close",
    "replace",
    "release-rejected",
    "registration-rejected",
    "cancelled-by-another-operator",
    "mixed-cancellation-source",
    "mixed-cancellation-same-source",
    "stale-batch-member",
  ] as const)("outlives execution and closes on %s", async (ending) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = createContext();
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const client = createOperatorClient({
        profileName: "completion-owner",
        scopes: ["operator.write"],
      });
      const revoked = new AbortController();
      const source = (await operatorCapture.captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
        },
      }))!;
      client.internal = { operatorRunAuthority: source.authority };
      try {
        const register = (runId = "child", actor = client) =>
          withPluginRuntimeGatewayRequestScope(
            {
              client: actor,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              registerSubagentRun(
                registration(runId, {
                  requesterAgentId: "main",
                  requesterTurnRunId: "parent",
                  ...(ending === "replace"
                    ? { childSessionKey: "global", childAgentId: "research" }
                    : {}),
                }),
              ),
          );
        if (ending === "registration-rejected") {
          vi.mocked(saveSubagentRegistryChangesToSqlite).mockImplementationOnce(() => {
            throw new Error("write refused");
          });
          await expect(register()).rejects.toThrow("write refused");
          source.release();
          expect(source.authority.assertCurrent).toThrow();
          expect(subagentRuns.has("child")).toBe(false);
          return;
        }
        await register();
        source.release();
        // This is the regression: execution closing must not close registered completion custody.
        expect(source.authority.assertCurrent).not.toThrow();
        const entry = subagentRuns.get("child")!;
        subagentRuns.runWithCompletionAuthority(entry, () => {
          const retained =
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
          expect(retained?.source).toBe(source.authority.source);
          expect(retained?.scopes).toEqual(["operator.write"]);
        });
        if (ending === "settle") {
          entry.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
          entry.cleanupCompletedAt = 1;
          entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
          persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
          expect(source.authority.assertCurrent).not.toThrow();
          entry.requesterTurnRunId = undefined;
          entry.requesterSettleWake = undefined;
          entry.delivery = { status: "delivered" };
          persistSubagentRunsToDiskOrThrow(subagentRuns, [entry.runId]);
        } else if (ending === "cancelled-by-another-operator") {
          revoked.abort(new Error("operator revoked"));
          entry.execution = {
            status: "terminal",
            endedAt: 1,
            outcome: { status: "error", error: "cancelled" },
          };
          entry.endedReason = "subagent-killed";
          const observer = createOperatorClient({
            profileName: "cancellation-owner",
            scopes: ["operator.write"],
          });
          withPluginRuntimeGatewayRequestScope(
            { client: observer, context, isWebchatConnect: () => false },
            () =>
              subagentRuns.runWithCompletionAuthority(entry, () =>
                expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(observer),
              ),
          );
          releaseSubagentRun(entry.runId);
        } else if (ending === "mixed-cancellation-source") {
          await register(
            "other",
            createOperatorClient({ profileName: "other-owner", scopes: ["operator.write"] }),
          );
          const other = subagentRuns.get("other")!;
          other.execution = {
            status: "terminal",
            endedAt: 1,
            outcome: { status: "error", error: "cancelled" },
          };
          other.endedReason = "subagent-killed";
          expect(() =>
            subagentRuns.runWithCompletionBatchAuthority([entry, other], () => "wrong caller"),
          ).toThrow(/incompatible operator authority/);
          releaseSubagentRun(entry.runId);
          releaseSubagentRun(other.runId);
        } else if (ending === "mixed-cancellation-same-source" || ending === "stale-batch-member") {
          await register("other");
          const other = subagentRuns.get("other")!;
          if (ending === "stale-batch-member") {
            subagentRuns.delete(other.runId);
            expect(() =>
              subagentRuns.runWithCompletionBatchAuthority([entry, other], () => "stale"),
            ).toThrow(/authority/);
            subagentRuns.set(other.runId, other);
          } else {
            other.execution = {
              status: "terminal",
              endedAt: 1,
              outcome: { status: "error", error: "cancelled" },
            };
            other.endedReason = "subagent-killed";
            subagentRuns.runWithCompletionBatchAuthority([other, entry], () =>
              expect(
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority
                  ?.source,
              ).toBe(source.authority.source),
            );
          }
          releaseSubagentRun(entry.runId);
          releaseSubagentRun(other.runId);
        } else if (ending === "gateway-close") {
          getGatewayContextLifetime(resolveGatewayContext).abort();
        } else if (ending === "replace") {
          expect(
            replaceSubagentRunAfterSteerCore({
              previousRunId: entry.runId,
              nextRunId: "successor",
              expected: entry,
              preserveRequesterSettleWake: true,
            }),
          ).toBe(true);
          expect(subagentRuns.get("successor")?.childAgentId).toBe("research");
          expect(source.authority.assertCurrent).not.toThrow();
          expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
            /authority/,
          );
          releaseSubagentRun("successor");
        } else if (ending === "release-rejected") {
          vi.mocked(saveSubagentRegistryChangesToSqlite).mockImplementationOnce(() => {
            throw new Error("write refused");
          });
          expect(() => releaseSubagentRun(entry.runId)).toThrow("write refused");
          expect(source.authority.assertCurrent).not.toThrow();
          releaseSubagentRun(entry.runId);
        } else {
          entry.requesterTurnRunId = undefined;
          revoked.abort(new Error("operator revoked"));
          await expect(
            adoptSubagentRunForRequesterTurn({
              expected: entry,
              requesterSessionKey: entry.requesterSessionKey,
              requesterAgentId: "main",
              requesterTurnRunId: "next-parent",
              assertCurrent: () => {},
            }),
          ).rejects.toThrow(/authority/);
        }
        expect(source.authority.assertCurrent).toThrow();
        expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
          /authority/,
        );
      } finally {
        source.release();
        resetSubagentRegistryForTests({ persist: false });
      }
    });
  });
});
