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
import { createAgentRuntimeApprovalAuthorityValidator } from "../../../gateway/agent-runtime-approval-authority.js";
import { callGateway } from "../../../gateway/call.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import { bindGatewayLifecycleRequest } from "../../../gateway/server-lifecycle-runtime-context.js";
import type { GatewayRequestHandlerOptions } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcessRaw } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { onAgentEvent, rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
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
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { createOperationalRunInstanceRef } from "../../operational-run-instance.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "../announce/subagent-announce-overrides.test-support.js";
import * as announce from "../announce/subagent-announce.js";
import {
  runWithCompletionBatchOrigin,
  runWithCompletionOrigin,
} from "./subagent-completion-origin.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import {
  operatorFixture,
  retainedOperatorFixture,
  registerCompletedFollowupAuthorityTests,
} from "./subagent-registry.completed-followup-authority.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { registerSubagentRegistrationOwnershipTests } from "./subagent-registry.registration-ownership.test-support.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../gateway/server-lifecycle-runtime-context.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });

function useConfig<T extends OpenClawConfig>(cfg: T) {
  config.setRuntimeConfigSnapshot(cfg);
  vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
  return cfg;
}

function inGateway<T>(
  scope: Omit<Parameters<typeof withPluginRuntimeGatewayRequestScope>[0], "isWebchatConnect">,
  run: () => T,
) {
  return withPluginRuntimeGatewayRequestScope({ ...scope, isWebchatConnect: () => false }, run);
}

function completionAuthority() {
  return getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
}

async function updateRun(runId: string, update: (draft: SubagentRunRecord) => void): Promise<void> {
  await mutateSubagentRuns([runId], (rows) => {
    const current = expectDefined(rows.get(runId), "completion authority fixture run");
    const draft = structuredClone(current);
    update(draft);
    return { value: undefined, postimages: new Map([[runId, draft]]) };
  });
}

async function markCancelled(runId: string) {
  await updateRun(runId, (draft) => {
    draft.execution = {
      status: "terminal",
      endedAt: 1,
      outcome: { status: "error", error: "cancelled" },
    };
    draft.endedReason = "subagent-killed";
  });
}

function rejectNextRegistryWrite(message: string): void {
  let reject = true;
  const spy = probe.command(stateWorker, async (command, options, scope) => {
    if (reject && command.type === "subagents.persistChanges") {
      reject = false;
      throw new Error(message);
    }
    return scope.execute(command, options);
  });
  onTestFinished(() => spy.mockRestore());
}

function registration(
  runId: string,
  overrides: Partial<Parameters<typeof registerSubagentRun>[0]> = {},
): Parameters<typeof registerSubagentRun>[0] {
  config.setRuntimeConfigSnapshot(config.getRuntimeConfig());
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    childAgentId: "main",
    sessionEntry: { sessionId: `original-${runId}` },
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
  vi.mocked(config.getRuntimeConfig).mockReset();
});

describe("registered completion source custody", () => {
  registerSubagentRegistrationOwnershipTests({ registration, updateRun });
  registerCompletedFollowupAuthorityTests({ registration, updateRun });

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
        useConfig({ session: { store: state.path("sessions.json") } });
        const runId = "worker-registration";
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let current = true;
        let observedOwnershipPublication = false;
        const afterOwnership = transition.endsWith("after ownership publication");
        let registrationScope: SubagentRegistrationScope | undefined;
        const gatewayBinding = { current: createContext() };
        const resolveGatewayContext = () => gatewayBinding.current;
        const stopObserving = subscribeSubagentRunChanges("projection", ({ runIds }) => {
          if (afterOwnership && runIds?.includes(runId) && subagentRuns.has(runId)) {
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
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Registration completed without entering worker persistence",
          );
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
            } else {
              await expect(pending).rejects.toThrow(
                transition === "gateway after ownership publication"
                  ? "lost its original run owner"
                  : "requester retired before registry commit",
              );
              expect(observedOwnershipPublication).toBe(true);
            }
            for (const entry of [
              subagentRuns.get(runId),
              loadSubagentRegistryFromSqlite().get(runId),
            ]) {
              expect(entry).toMatchObject({ execution: { status: "running" } });
            }
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
            expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
              method: "agent.wait",
              params: { runId },
            });
            const accepted = subagentRuns.get(runId);
            expect(accepted?.childAgentId).toBe("main");
            await registerSubagentRun(registration(runId, { childAgentId: "MAIN" }), {
              acceptedRunReplay: true,
            });
            expect(subagentRuns.get(runId)).toBe(accepted);
            await expect(
              registerSubagentRun(registration(runId, { childAgentId: "research" }), {
                acceptedRunReplay: true,
              }),
            ).rejects.toThrow("explicit valid child agent");
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

  // Live revocation of a launch handle no longer reaches delivery; policy revocation does (E2E).
  it.for(["current"] as const)(
    "rechecks %s registered completion authority at the final outbound adapter",
    async (_authority, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = useConfig({ session: { store: state.path("sessions.json") } });
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
        const { context, client } = operatorFixture("registered-final-delivery");
        context.getRuntimeConfig = () => cfg;
        const terminal = createDeferredCore<unknown>();
        const sendGate = createEnteredGate();
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
                beforeSendAttempt: sendGate.wait,
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
          await inGateway({ client, context, resolveGatewayContext: () => context }, () =>
            registerSubagentRun(
              registration(runId, {
                childSessionKey,
                sessionEntry: { sessionId: "completion-child" },
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
              sendGate.entered,
              flowCompleted.promise,
              "Registered completion did not reach its final outbound adapter",
            ),
            signal,
          );
          expect(received).toEqual([]);
          expect(subagentRuns.get(runId)?.execution.status).toBe("terminal");
          sendGate.release();
          await withinTest(flowCompleted.promise, signal);
          await settleSubagentRegistryPersistenceWork(() => settleRoots(true));
          const stored = expectDefined(
            loadSubagentRegistryFromSqlite().get(runId),
            "retained result",
          );
          expect(received).toEqual([content]);
          expect(sendText).toHaveBeenCalledTimes(1);
          expect(stored.delivery?.status).toBe("delivered");
          expect(
            loadSessionEntry({ storePath: cfg.session.store, sessionKey: childSessionKey }),
          ).toMatchObject({ sessionId: "completion-child" });
        } catch (error) {
          failures.push(error);
        } finally {
          terminal.resolve({ status: "pending" });
          sendGate.release();
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

  it.each(["completed System parent", "mixed System scopes"] as const)(
    "preserves registered completion authority for %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = useConfig({ session: { store: state.path("sessions.json") } });
        const requesterSessionKey = "agent:main:main";
        const handler = ({ client, respond }: GatewayRequestHandlerOptions) => {
          respond(true, {
            scopes: client?.connect.scopes,
            runtime: client?.internal?.agentRuntimeIdentity,
          });
        };
        const validateRuntime = createAgentRuntimeApprovalAuthorityValidator();
        const createSource = () => {
          const context = createContext([["agent", "operator.write", "agent", handler]]);
          const resolveGatewayContext = () => context;
          context.resolveGatewayContext = resolveGatewayContext;
          context.getRuntimeConfig = () => cfg;
          context.validateAgentRuntimeApprovalAuthority = validateRuntime;
          return { context, resolveGatewayContext };
        };
        const source = createSource();
        const operationalRunInstance = createOperationalRunInstanceRef("system-completion-parent");
        const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
        onTestFinished(() => void releaseAgentRunDelegatedAuthority(delegatedAuthority));
        const client = createSyntheticPluginRuntimeClient({
          scopes: ["operator.write"],
          operatorRoleActor: { kind: "system" },
        });
        client.internal = {
          ...client.internal,
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: requesterSessionKey,
            operationalRunInstance,
            delegatedAuthority: { kind: "local", ...delegatedAuthority },
          },
        };
        for (const [runId, owner, scopes] of [
          ["system-child", source, ["operator.write"]],
          [
            "system-sibling",
            source,
            scenario === "mixed System scopes"
              ? ["operator.write", "operator.approvals"]
              : ["operator.write"],
          ],
        ] as const) {
          await inGateway(
            {
              client: { ...client, connect: { ...client.connect, scopes: [...scopes] } },
              ...owner,
            },
            () =>
              registerSubagentRun(
                registration(runId, { gatewayContextResolver: owner.resolveGatewayContext }),
              ),
          );
        }
        const entry = expectDefined(subagentRuns.get("system-child"), "registered System child");
        const sibling = expectDefined(
          subagentRuns.get("system-sibling"),
          "registered System sibling",
        );
        releaseAgentRunDelegatedAuthority(delegatedAuthority);
        expect(validateRuntime(client.internal.agentRuntimeIdentity!)).toBe(false);
        expect(entry.originFacts).toEqual({ kind: "system", scopes: ["operator.write"] });
        const dispatch = vi.fn(() =>
          dispatchGatewayMethodInProcessRaw(
            "agent",
            {
              message: "Accepted child result",
              sessionKey: requesterSessionKey,
              idempotencyKey: "system-completion",
            },
            { syntheticScopeMode: "exact" },
          ),
        );
        await inGateway({ ...source, client }, async () => {
          if (scenario === "completed System parent") {
            for (const deliver of [
              () => runWithCompletionOrigin(entry, dispatch),
              () => runWithCompletionBatchOrigin([entry, sibling], dispatch),
            ]) {
              await expect(deliver()).resolves.toMatchObject({
                ok: true,
                payload: { scopes: ["operator.write"], runtime: undefined },
              });
            }
          } else {
            await expect(runWithCompletionBatchOrigin([entry, sibling], dispatch)).rejects.toThrow(
              "Subagent completion batch has incompatible operator authority",
            );
            expect(dispatch).not.toHaveBeenCalled();
          }
        });
      });
    },
  );

  it.each([
    "admission",
    "lifecycle",
    "replacement",
    "failed child replacement",
    "unrelated child",
    "store",
    "source callback",
  ] as const)(
    "preserves the selected registration owner when %s changes during preparation",
    async (changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        let cfg: OpenClawConfig = { session: { store: state.path("original.sqlite") } };
        config.setRuntimeConfigSnapshot(cfg);
        const {
          context,
          client,
          revoked: sourceController,
        } = operatorFixture("preparing-registration");
        context.getRuntimeConfig = () => cfg;
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
        const pending = inGateway({ client, context }, () =>
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
          } else if (changed === "failed child replacement" || changed === "unrelated child") {
            const registerNewChild = () =>
              registerSubagentRun(
                registration("newer-child", {
                  childSessionKey:
                    changed === "unrelated child"
                      ? "agent:main:subagent:unrelated"
                      : childSessionKey,
                  task: "newer child",
                  expectsCompletionMessage: false,
                }),
              );
            if (changed === "failed child replacement") {
              rejectNextRegistryWrite("replacement write refused");
              await expect(registerNewChild()).rejects.toThrow("replacement write refused");
              expect(subagentRuns.has("newer-child")).toBe(false);
            } else {
              await registerNewChild();
              expect(subagentRuns.get("newer-child")).toBeDefined();
            }
          } else if (changed === "store") {
            cfg = { session: { store: state.path("replacement.sqlite") } };
            config.setRuntimeConfigSnapshot(cfg);
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
            expect(subagentRuns.get(runId)).toMatchObject({
              requesterStorePath: originalPath,
              controllerStorePath: originalPath,
              childAgentId: "main",
            });
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
    "requester",
    "cancelled-without-origin",
    "cancelled-with-origin",
    "mixed-principals",
    "legacy-row",
  ] as const)("restores completion authority from saved origin facts (%s)", async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      config.setRuntimeConfigSnapshot({});
      const { context, resolveGatewayContext, client, source } =
        await retainedOperatorFixture("completion-owner");
      try {
        const register = (runId = "child", actor = client) =>
          inGateway({ client: actor, context, resolveGatewayContext }, () =>
            registerSubagentRun(
              registration(runId, {
                requesterAgentId: "main",
                requesterTurnRunId: "parent",
                gatewayContextResolver: resolveGatewayContext,
              }),
            ),
          );
        await register();
        // The registration's live source ends; the row's saved facts still carry its origin.
        source.release();
        const entry = subagentRuns.get("child")!;
        expect(entry.originFacts).toMatchObject({ kind: "gateway" });
        const observer = createOperatorClient({
          profileName: "cancellation-owner",
          scopes: ["operator.admin", "operator.write"],
        });
        const requesterProfile = client.authenticatedUserProfile?.profileId;
        const readProfile = async () => completionAuthority()?.profileId;
        if (scenario === "requester") {
          await expect(runWithCompletionOrigin(entry, readProfile)).resolves.toBe(requesterProfile);
          await expect(
            runWithCompletionOrigin(entry, async () => completionAuthority()?.scopes),
          ).resolves.toEqual(["operator.write"]);
        } else if (scenario === "cancelled-with-origin") {
          await markCancelled(entry.runId);
          await inGateway({ client: observer, context }, async () => {
            await expect(
              runWithCompletionOrigin(subagentRuns.get("child")!, readProfile),
            ).resolves.toBe(requesterProfile);
          });
        } else if (scenario === "cancelled-without-origin") {
          await updateRun(entry.runId, (draft) => {
            delete draft.originFacts;
          });
          await markCancelled(entry.runId);
          await inGateway({ client: observer, context }, async () => {
            await runWithCompletionOrigin(subagentRuns.get("child")!, async () =>
              expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(observer),
            );
          });
        } else if (scenario === "mixed-principals") {
          await register(
            "other",
            createOperatorClient({ profileName: "other-owner", scopes: ["operator.write"] }),
          );
          await expect(
            runWithCompletionBatchOrigin(
              [entry, subagentRuns.get("other")!],
              async () => "wrong caller",
            ),
          ).rejects.toThrow(/incompatible operator authority/);
        } else {
          // A row written before origin facts never widens to the requester session owner.
          await updateRun(entry.runId, (draft) => {
            delete draft.originFacts;
          });
          await expect(
            runWithCompletionOrigin(subagentRuns.get("child")!, readProfile),
          ).rejects.toThrow("withheld: the origin of this child run was not saved");
        }
      } finally {
        source.release();
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });
});
