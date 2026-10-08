import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { createMessageReceiptFromOutboundResults } from "../../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../../channels/plugins/types.public.js";
import * as config from "../../../config/config.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
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
import { getActivePluginRegistry, setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  getGatewayContextLifetime,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "../announce/subagent-announce-overrides.test-support.js";
import * as announce from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  adoptSubagentRunForRequesterTurn,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../gateway/server-recovery-runtime-context.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });

async function updateRun(runId: string, update: (draft: SubagentRunRecord) => void): Promise<void> {
  await mutateSubagentRuns([runId], (rows) => {
    const current = expectDefined(rows.get(runId), "completion authority fixture run");
    const draft = structuredClone(current);
    update(draft);
    return { value: undefined, postimages: new Map([[runId, draft]]) };
  });
}

function rejectNextRegistryWrite(message: string): void {
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  let reject = true;
  const spy = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      execute(
        context,
        (scope) =>
          operation({
            execute: async (...args) => {
              if (reject && args[0].type === "subagents.persistChanges") {
                reject = false;
                throw new Error(message);
              }
              return scope.execute(...args);
            },
          }),
        options,
      ),
    );
  onTestFinished(() => spy.mockRestore());
}

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

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  vi.mocked(callGateway).mockReset();
  vi.mocked(bindGatewayLifecycleRequest).mockReset();
  vi.mocked(onAgentEvent).mockReset();
});

describe("registered completion source custody", () => {
  it.each([
    "current",
    "before commit",
    "publication after commit",
    "caller after ownership publication",
    "gateway after ownership publication",
  ] as const)(
    "publishes accepted-run registration with current authority at each boundary (%s)",
    async (transition) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.path("sessions.json") } };
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const runId = "worker-registration";
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let current = true;
        let observedOwnershipPublication = false;
        let registrationScope: SubagentRegistrationScope | undefined;
        const gatewayBinding = { current: createContext() };
        const resolveGatewayContext = () => gatewayBinding.current;
        const stopObserving = subscribeSubagentRunChanges("projection", ({ runIds }) => {
          if (
            (transition === "caller after ownership publication" ||
              transition === "gateway after ownership publication") &&
            runIds?.includes(runId) &&
            subagentRuns.has(runId)
          ) {
            observedOwnershipPublication = true;
            if (transition === "gateway after ownership publication") {
              gatewayBinding.current = createContext();
            } else {
              current = false;
            }
          }
        });
        const execute = stateWorker.runOpenClawStateWorkerOperation;
        const held = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementationOnce(async (owner, run, options) => {
            entered.resolve();
            await release.promise;
            return execute(
              owner,
              async (scope) => {
                const result = await run(scope);
                if (transition === "publication after commit") {
                  current = false;
                }
                return result;
              },
              options,
            );
          });
        let pending: Promise<void> | undefined;
        try {
          pending = Promise.resolve(
            registerSubagentRun(
              registration(runId, { gatewayContextResolver: resolveGatewayContext }),
              {
                acceptedRunReplay: true,
                assertCurrent: () => {
                  if (!current) {
                    throw new Error("requester retired before registry commit");
                  }
                },
                assertPublicationCurrent: () => {
                  if (!current) {
                    throw new Error("requester retired after registry commit");
                  }
                },
                retainOwnership: (scope) => {
                  registrationScope = scope;
                },
              },
            ),
          );
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Registration completed without entering worker persistence");
            }),
          ]);
          expect(subagentRuns.has(runId)).toBe(false);
          expect(callGateway).not.toHaveBeenCalled();
          current = transition !== "before commit";
          release.resolve();
          if (transition === "before commit") {
            await expect(pending).rejects.toThrow("requester retired before registry commit");
            expect(subagentRuns.has(runId)).toBe(false);
            expect(callGateway).not.toHaveBeenCalled();
          } else if (transition !== "current") {
            if (transition === "publication after commit") {
              await expect(pending).rejects.toMatchObject({
                outcome: "committed",
                publication: "published",
              });
            } else if (transition === "gateway after ownership publication") {
              await expect(pending).rejects.toThrow("lost its original run owner");
              expect(observedOwnershipPublication).toBe(true);
            } else {
              await expect(pending).rejects.toThrow("requester retired before registry commit");
              expect(observedOwnershipPublication).toBe(true);
            }
            const entry = subagentRuns.get(runId);
            expect(entry).toMatchObject({ execution: { status: "running" } });
            expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
              execution: { status: "running" },
            });
            expect(registrationScope?.canLaunch()).toBe(false);
            expect(registrationScope?.canCleanupSession()).toBe(false);
            expect(registrationScope?.canAbortAcceptedRun()).toBe(true);
            expect(callGateway).not.toHaveBeenCalled();
            expect(onAgentEvent).toHaveBeenCalledOnce();
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
              acceptedRunReplay: true,
            });
            expect(subagentRuns.get(runId)).toBe(accepted);
            await expect(
              registerSubagentRun(registration(runId, { childAgentId: "research" }), {
                acceptedRunReplay: true,
              }),
            ).rejects.toThrow("Subagent registration child agent disagrees with its session key.");
            expect(callGateway).toHaveBeenCalledTimes(1);
          }
        } finally {
          release.resolve();
          await pending?.catch(() => {});
          stopObserving();
          held.mockRestore();
        }
      });
    },
  );

  it("keeps a committed registration restricted when its operator source expires before ACK", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = createContext();
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const client = createOperatorClient({
        profileName: "late-registration-source",
        scopes: ["operator.write"],
      });
      const revoked = new AbortController();
      const source = await operatorCapture.captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
        },
      });
      if (!source) {
        throw new Error("Expected an operator registration source");
      }
      client.internal = { operatorRunAuthority: source.authority };
      const params = registration("late-source-registration", {
        gatewayContextResolver: resolveGatewayContext,
      });
      const competingRegistration = subagentRuns.captureRegistrationOwnership(
        params.childSessionKey,
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      const held = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation((owner, run, options) =>
          execute(
            owner,
            (scope) =>
              run({
                execute: async (command, executeOptions) => {
                  const receipt = await scope.execute(command, executeOptions);
                  if (command.type === "subagents.persistChanges") {
                    entered.resolve();
                    await release.promise;
                  }
                  return receipt;
                },
              }),
            options,
          ),
        );
      const pending = withPluginRuntimeGatewayRequestScope(
        { client, context, resolveGatewayContext, isWebchatConnect: () => false },
        () => registerSubagentRun(params),
      );
      const outcome = pending.then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("Registration did not reach its native ACK gate");
          }),
        ]);
        expect(loadSubagentRegistryFromSqlite().has(params.runId)).toBe(true);
        expect(subagentRuns.has(params.runId)).toBe(false);
        revoked.abort(new Error("operator source revoked after commit"));
        release.resolve();
        await expect(outcome).resolves.toMatchObject({
          error: { outcome: "committed", publication: "published" },
        });
        const entry = subagentRuns.get(params.runId);
        if (!entry) {
          throw new Error("Committed registration row was not published");
        }
        expect(getGatewayContextResolver(entry)).toBe(resolveGatewayContext);
        expect(competingRegistration.assertCurrent).toThrow();
        expect(source.authority.assertCurrent).toThrow();
        const ambient = vi.fn();
        expect(() => subagentRuns.runWithCompletionAuthority(entry, ambient)).toThrow(
          "Subagent completion requester store was retired",
        );
        expect(() => subagentRuns.runWithCompletionBatchAuthority([entry], ambient)).toThrow(
          "Subagent completion requester store was retired",
        );
        expect(ambient).not.toHaveBeenCalled();
        expect(callGateway).not.toHaveBeenCalled();
        held.mockRestore();
        await updateRun(entry.runId, (draft) => {
          draft.label = "committed metadata";
        });
        const current = subagentRuns.get(entry.runId)!;
        expect(current).not.toBe(entry);
        expect(() => subagentRuns.runWithCompletionAuthority(current, ambient)).toThrow(
          "Subagent completion requester store was retired",
        );
        expect(getGatewayContextResolver(current)).toBe(resolveGatewayContext);
        expect(ambient).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await outcome;
        held.mockRestore();
        competingRegistration.release();
        source.release();
      }
    });
  });

  it.for(["current", "revoked"] as const)(
    "rechecks %s registered completion authority at the final outbound adapter",
    async (authority, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.path("sessions.json") } };
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const requesterSessionKey = "agent:main:discord:dm:registered-completion";
        const childSessionKey = "agent:main:subagent:registered-final-delivery";
        const runId = "registered-final-delivery";
        const content = "Acknowledged child result";
        for (const [sessionKey, sessionId] of [
          [requesterSessionKey, "completion-requester"],
          [childSessionKey, "completion-child"],
        ] as const) {
          await upsertSessionEntryCore(
            { storePath: cfg.session.store, sessionKey, agentId: "main" },
            { sessionId, updatedAt: Date.now() },
          );
        }
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
        context.resolveGatewayContext = () => context;
        const client = createOperatorClient({
          profileName: "registered-final-delivery",
          scopes: ["operator.write"],
        });
        const revoked = new AbortController();
        client.internal = {
          operatorAccessAuthority: {
            signal: revoked.signal,
            assertCurrent: () => revoked.signal.throwIfAborted(),
          },
        };
        const terminal = createDeferredCore<unknown>();
        const beforeSend = createDeferredCore();
        const releaseSend = createDeferredCore();
        const flowCompleted = createDeferredCore<announce.SubagentAnnounceFlowOutcome>();
        let announcement: ReturnType<typeof announce.runSubagentAnnounceFlow> | undefined;
        const actualAnnounce = announce.runSubagentAnnounceFlow;
        const announceSpy = vi
          .spyOn(announce, "runSubagentAnnounceFlow")
          .mockImplementation((params) => {
            announcement = actualAnnounce(params);
            void announcement.then(flowCompleted.resolve, flowCompleted.reject);
            return announcement;
          });
        const received: string[] = [];
        const sendText = vi.fn(async ({ text }: { text: string }) => {
          received.push(text);
          return {
            messageId: "registered-completion-result",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "discord", messageId: "registered-completion-result" }],
              kind: "text",
            }),
          };
        });
        const channel = {
          ...createChannelTestPluginBase({ id: "discord" }),
          message: {
            id: "discord",
            send: {
              lifecycle: {
                beforeSendAttempt: async () => {
                  beforeSend.resolve();
                  await releaseSend.promise;
                },
              },
              text: sendText,
            },
          },
        } satisfies ChannelPlugin;
        const previousRegistry = getActivePluginRegistry();
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "discord", source: "test", plugin: channel }]),
        );
        setSubagentAnnounceDeliveryDepsForTest({
          dispatchGatewayMethodInProcess: vi.fn().mockResolvedValue({
            status: "ok",
            result: { payloads: [{ text: content }], meta: { durationMs: 1 } },
          }),
        });
        vi.mocked(callGateway).mockReturnValue(terminal.promise);
        const settleRoots = observeRootWork();
        const failures: unknown[] = [];
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              registerSubagentRun(
                registration(runId, {
                  childSessionKey,
                  requesterSessionKey,
                  requesterAgentId: "main",
                  requesterOrigin: { channel: "discord", to: "dm:registered-completion" },
                  gatewayContextResolver: () => context,
                }),
              ),
          );
          const entry = expectDefined(subagentRuns.get(runId), "acknowledged registration");
          expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
            childSessionKey,
            execution: { status: "running" },
          });
          await appendTranscriptMessage(
            {
              storePath: cfg.session.store,
              sessionKey: childSessionKey,
              sessionId: "completion-child",
              agentId: "main",
            },
            {
              message: {
                role: "assistant",
                content: [{ type: "text", text: content }],
                stopReason: "stop",
                __openclaw: { runId },
              },
            },
          );
          terminal.resolve({
            status: "ok",
            startedAt: entry.createdAt,
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: content },
          });
          await withinTest(
            awaitGateBeforeSettlement(
              beforeSend.promise,
              flowCompleted.promise,
              "Registered completion did not reach its final outbound adapter",
            ),
            signal,
          );
          expect(received).toEqual([]);
          expect(subagentRuns.get(runId)?.execution.status).toBe("terminal");
          if (authority === "revoked") {
            revoked.abort(new Error("registered completion operator revoked"));
          }
          releaseSend.resolve();
          await withinTest(flowCompleted.promise, signal);
          await settleSubagentRegistryPersistenceWork(() => settleRoots(true));
          const stored = expectDefined(
            loadSubagentRegistryFromSqlite().get(runId),
            "retained result",
          );
          if (authority === "current") {
            expect(received).toEqual([content]);
            expect(sendText).toHaveBeenCalledOnce();
            expect(stored.delivery?.status).toBe("delivered");
          } else {
            expect(received).toEqual([]);
            expect(sendText).not.toHaveBeenCalled();
            expect(stored.delivery?.status).not.toBe("delivered");
          }
          expect(
            loadSessionEntry({ storePath: cfg.session.store, sessionKey: childSessionKey }),
          ).toMatchObject({ sessionId: "completion-child" });
        } catch (error) {
          failures.push(error);
        } finally {
          terminal.resolve({ status: "pending" });
          releaseSend.resolve();
          const settled = await Promise.allSettled([announcement]);
          failures.push(
            ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          );
          try {
            await settleSubagentRegistryPersistenceWork(() => settleRoots());
          } catch (error) {
            failures.push(error);
          }
          await resetSubagentRegistryForTests({ persist: false });
          announceSpy.mockRestore();
          setSubagentAnnounceDeliveryDepsForTest();
          setActivePluginRegistry(previousRegistry ?? createTestRegistry());
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Registered completion delivery proof failed");
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
        await registerSubagentRun(
          { ...params, childAgentId: "main" },
          {
            acceptedRunReplay: true,
          },
        );
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
              rejectNextRegistryWrite("replacement write refused");
              await expect(registerNewChild()).rejects.toThrow("replacement write refused");
              expect(subagentRuns.has("newer-child")).toBe(false);
            } else {
              await registerNewChild();
              expect(subagentRuns.get("newer-child")).toBeDefined();
              if (changed === "retired child replacement") {
                await releaseSubagentRun("newer-child");
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
            await releaseSubagentRun(runId);
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
          await resetSubagentRegistryForTests({ persist: false });
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
          rejectNextRegistryWrite("write refused");
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
          await updateRun(entry.runId, (draft) => {
            draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
            draft.cleanupCompletedAt = 1;
            draft.requesterSettleWake = { status: "pending", attemptCount: 0 };
          });
          expect(source.authority.assertCurrent).not.toThrow();
          await updateRun(entry.runId, (draft) => {
            draft.requesterTurnRunId = undefined;
            draft.requesterSettleWake = undefined;
            draft.delivery = { status: "delivered" };
          });
        } else if (ending === "cancelled-by-another-operator") {
          revoked.abort(new Error("operator revoked"));
          await updateRun(entry.runId, (draft) => {
            draft.execution = {
              status: "terminal",
              endedAt: 1,
              outcome: { status: "error", error: "cancelled" },
            };
            draft.endedReason = "subagent-killed";
          });
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
          await releaseSubagentRun(entry.runId);
        } else if (ending === "mixed-cancellation-source") {
          await register(
            "other",
            createOperatorClient({ profileName: "other-owner", scopes: ["operator.write"] }),
          );
          const other = subagentRuns.get("other")!;
          await updateRun(other.runId, (draft) => {
            draft.execution = {
              status: "terminal",
              endedAt: 1,
              outcome: { status: "error", error: "cancelled" },
            };
            draft.endedReason = "subagent-killed";
          });
          expect(() =>
            subagentRuns.runWithCompletionBatchAuthority([entry, other], () => "wrong caller"),
          ).toThrow(/incompatible operator authority/);
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(other.runId);
        } else if (ending === "mixed-cancellation-same-source" || ending === "stale-batch-member") {
          await register("other");
          const other = subagentRuns.get("other")!;
          if (ending === "stale-batch-member") {
            await releaseSubagentRun(other.runId);
            expect(() =>
              subagentRuns.runWithCompletionBatchAuthority([entry, other], () => "stale"),
            ).toThrow(/authority/);
          } else {
            await updateRun(other.runId, (draft) => {
              draft.execution = {
                status: "terminal",
                endedAt: 1,
                outcome: { status: "error", error: "cancelled" },
              };
              draft.endedReason = "subagent-killed";
            });
            subagentRuns.runWithCompletionBatchAuthority([other, entry], () =>
              expect(
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority
                  ?.source,
              ).toBe(source.authority.source),
            );
          }
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(other.runId);
        } else if (ending === "gateway-close") {
          getGatewayContextLifetime(resolveGatewayContext).abort();
        } else if (ending === "replace") {
          expect(
            await replaceSubagentRunAfterSteerCore({
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
          await releaseSubagentRun("successor");
        } else if (ending === "release-rejected") {
          rejectNextRegistryWrite("write refused");
          await expect(releaseSubagentRun(entry.runId)).rejects.toThrow("write refused");
          expect(source.authority.assertCurrent).not.toThrow();
          await releaseSubagentRun(entry.runId);
        } else {
          await updateRun(entry.runId, (draft) => {
            draft.requesterTurnRunId = undefined;
          });
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
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });
});
