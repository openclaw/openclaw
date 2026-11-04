import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { holdForeignWriter } from "../infra/sqlite-worker-shared-state-admission.test-support.js";
import { preparePluginStateGuard } from "../plugin-sdk/plugin-state-runtime.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";
import {
  bindCommandHarnessCompletionAssertion,
  buildCurrentRunRestartRecoveryClaim,
  prepareCommandHarnessCompletionRecovery,
} from "./agent-command-restart-recovery.js";
import {
  captureHarnessCompletionRecovery as captureRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask as owedTask,
} from "./agent-harness-completion-recovery.js";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission as withAdmission,
} from "./agent-harness-completion-scope.js";
import { runWithAgentToolSourceExecutionScope } from "./agent-tool-source-execution-guard.js";
import { persistAgentSession } from "./command/attempt-execution.shared.js";

const requesterSessionKey = "agent:main:main";
const sourceSessionKey = "native-child:one";
const sourceRunId = "announce:one";

afterEach(() => resetPluginStateStoreForTests({ closeDatabase: false }));

function input() {
  const entry: SessionEntry = {
    sessionId: "requester-one",
    updatedAt: 1,
    lifecycleRevision: "revision-one",
  };
  return {
    agentId: "main",
    sessionKey: requesterSessionKey,
    entry,
    runId: sourceRunId,
    inputProvenance: {
      kind: "inter_session" as const,
      sourceChannel: "internal",
      sourceTool: "agent_harness_completion",
      sourceSessionKey,
    },
  };
}
function makeAdmission(
  params: Parameters<typeof captureRecovery>[0] = input(),
  overrides: Partial<Parameters<typeof withAdmission>[0]> = {},
) {
  return {
    scope: createAgentHarnessCompletionScope({
      requesterSessionKey: params.sessionKey,
      requesterAgentId: params.agentId,
    }),
    sourceSessionKey,
    sourceRunId: params.runId,
    requesterSessionId: params.entry.sessionId,
    requesterLifecycleRevision: params.entry.lifecycleRevision,
    isSourceCurrent: () => true,
    ...overrides,
  };
}
async function captureForNativeRequester(params: Parameters<typeof captureRecovery>[0]) {
  const claim = await withAdmission(makeAdmission(params), async () => captureRecovery(params));
  assert(claim, "missing admitted claim");
  return claim;
}
it("rejects forged provenance and structurally copied scopes", async () => {
  expect(() => captureRecovery(input())).toThrow("host-issued source admission");
  const { scope } = makeAdmission();
  await expect(
    withAdmission(makeAdmission(input(), { scope: { ...scope } }), async () => {}),
  ).rejects.toThrow("host-issued scope");
});
it("transfers admitted source custody to its exact durable requester receipt without a task row", async () => {
  const params = input();
  const claim = await captureForNativeRequester(params);
  const restored = structuredClone(claim);
  expect(owedTask(restored, params.entry)).toBeUndefined();
  const saved = { ...params.entry, restartRecoveryHarnessCompletion: restored };
  expect(owedTask(restored, saved)).toEqual(restored);
  expect(owedTask(restored, { ...saved, sessionId: "replaced" })).toBeUndefined();
  expect(owedTask({ ...restored, requesterAgentId: "other" }, saved)).toBeUndefined();
});
it.each(["retained", "receipt-only", "task", "outcome", "source"] as const)(
  "does not let historical terminal evidence overrule %s current custody",
  async (variant) => {
    const params = input();
    const claim = await captureForNativeRequester(params);
    const currentClaim = {
      ...claim,
      ...(variant === "task" && { taskRunId: "other-child" }),
      ...(variant === "outcome" && { taskStatus: "failed" as const }),
      ...(variant === "source" && { sourceRunId: "announce:other" }),
    };
    const entry: SessionEntry = {
      ...params.entry,
      restartRecoveryHarnessCompletion: variant === "receipt-only" ? undefined : currentClaim,
      restartRecoveryTerminalDeliveryEvidence: [
        { runId: claim.sourceRunId, harnessCompletion: { ...claim }, captured: true },
      ],
    };
    const owed = owedTask(structuredClone(claim), entry);
    expect(owed).toEqual(variant === "retained" || variant === "receipt-only" ? claim : undefined);
  },
);
it("revalidates native source ownership after awaited work", async () => {
  const params = input();
  let current = true;
  await withAdmission(makeAdmission(params, { isSourceCurrent: () => current }), async () => {
    await Promise.resolve();
    current = false;
    expect(() => captureRecovery(params)).toThrow("source owner retired");
  });
});

const inputProvenance = {
  ...input().inputProvenance,
  sourceTool: "agent_harness_task",
};
async function setupNativeRequester(state: OpenClawTestState) {
  const target = {
    agentId: "main",
    sessionKey: requesterSessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = {
    sessionId: "physical-one",
    lifecycleRevision: "revision-one",
    updatedAt: Date.now(),
  };
  await replaceSessionEntry(target, entry);
  return { target, entry };
}
it.each([
  "metadata",
  "binding replacement",
  "source revocation",
  "requester reassignment",
] as const)(
  "checks %s before transferring native custody to a durable requester receipt",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const { target } = await setupNativeRequester(state);
      const entry = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
      assert(entry);
      let sourceCurrent = true;
      const store = createPluginStateKeyedStore<{ owner: string; metadata?: number }>(
        "completion-admission-test",
        { namespace: "bindings", maxEntries: 10, overflowPolicy: "reject-new", env: state.env },
        () => {
          if (!sourceCurrent) {
            throw new Error("Native source revoked");
          }
        },
      );
      await store.register("child", { owner: "original" });
      const observed = await store.observe("child");
      const guard = await preparePluginStateGuard(store, "child", (value) => {
        if (value?.owner !== "original") {
          throw new Error("Native binding replaced");
        }
      });
      assert(guard);
      const captured = createDeferred();
      const resume = createDeferred();
      const checks: Array<{ current: boolean; mutationPending: boolean }> = [];
      let foreign: ReturnType<typeof holdForeignWriter> | undefined;
      let mutation: Promise<unknown> | undefined;
      let mutationSettled = false;
      const params = { ...input(), entry };
      const operation = withAdmission(
        makeAdmission(params, {
          isSourceCurrent: () => {
            guard.assertCurrent();
            return true;
          },
        }),
        async () => {
          const recovery = prepareCommandHarnessCompletionRecovery({
            ...params,
            sessionId: entry.sessionId,
            opts: { message: "Completed child result", inputProvenance: params.inputProvenance },
            hasDeliveryContext: true,
          });
          assert(recovery.harnessCompletion);
          captured.resolve();
          await resume.promise;
          const persisted = await persistAgentSession({
            ...target,
            sessionStore: { [target.sessionKey]: entry },
            initialEntry: entry,
            entry: {
              ...entry,
              ...buildCurrentRunRestartRecoveryClaim({
                entry,
                runId: sourceRunId,
                harnessCompletion: recovery.harnessCompletion,
                ...recovery.sourceOptions,
              }),
            },
            shouldPersist: (current) => {
              try {
                const allowed = recovery.isCompletionCurrent(current);
                checks.push({
                  current: allowed,
                  mutationPending: Boolean(mutation) && !mutationSettled,
                });
                return allowed;
              } finally {
                // Keep the real CAS pending through the checkpoint's source check.
                foreign?.close();
              }
            },
          });
          bindCommandHarnessCompletionAssertion({
            claim: recovery.guardedHarnessCompletion,
            persisted,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            opts: { message: "Completed child result" },
          });
          return recovery.harnessCompletion;
        },
      );
      void operation.catch(() => {});
      const replacement = {
        ...entry,
        sessionId: "requester-replacement",
        lifecycleRevision: "revision-two",
      };
      try {
        await Promise.race([captured.promise, operation]);
        expect(checks).toEqual([]);
        if (change === "metadata" || change === "binding replacement") {
          foreign = holdForeignWriter(captureOpenClawStateWorkerContext({ env: state.env }));
          mutation = store
            .compareAndApply("child", observed.comparison, {
              operation: "update",
              action: "set",
              value: { owner: change === "metadata" ? "original" : "replacement", metadata: 1 },
            })
            .finally(() => {
              mutationSettled = true;
            });
          void mutation.catch(() => {});
        } else if (change === "source revocation") {
          sourceCurrent = false;
        } else {
          await replaceSessionEntry(target, replacement);
        }
        resume.resolve();
        if (change === "metadata") {
          const claim = await operation;
          await mutation;
          const saved = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
          expect(saved?.restartRecoveryHarnessCompletion).toEqual(claim);
          expect(saved?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);
          expect(saved?.restartRecoverySourceIngress).toBe("internal");
          assert(saved);
          sourceCurrent = false;
          expect(owedTask(structuredClone(claim), saved)).toEqual(claim);
        } else {
          await expect(operation).rejects.toThrow();
          await mutation;
          const saved = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
          expect(saved).toEqual(change === "requester reassignment" ? replacement : entry);
          expect(saved?.restartRecoveryHarnessCompletion).toBeUndefined();
          expect(saved?.restartRecoveryDeliverySourceRunId).toBeUndefined();
        }
        expect(checks).toEqual([
          { current: change === "metadata", mutationPending: Boolean(mutation) },
        ]);
      } finally {
        resume.resolve();
        foreign?.close();
        await Promise.allSettled([operation, ...(mutation ? [mutation] : [])]);
        guard.release();
      }
    });
  },
);
it.each(["current", "prior", "unadmitted-prior", "foreign-source", "human"] as const)(
  "retains exact pre-mirror recovery admission after the real recorder commits %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const { target, entry: original } = await setupNativeRequester(state);
      const claim = await captureForNativeRequester({
        ...input(),
        entry: original,
        inputProvenance,
      });
      const entry = {
        ...original,
        ...buildCurrentRunRestartRecoveryClaim({
          entry: original,
          runId: sourceRunId,
          sourceRunId,
          sourceIngress: "internal",
          sourceReplyDeliveryMode: "automatic",
          deliveryContext: { channel: "discord", to: "channel:123", accountId: "main" },
          harnessCompletion: claim,
        }),
      };
      await replaceSessionEntry(target, entry);
      const transcript = { ...target, sessionId: entry.sessionId };
      await appendTranscriptMessage(transcript, {
        message: {
          role: "user",
          content: "completed child",
          idempotencyKey: `${sourceRunId}:user`,
          __openclaw: { runId: sourceRunId },
          provenance: inputProvenance,
        },
      });
      const recoveryRunId = "recorder-recovery-current";
      const priorRunId = "recorder-recovery-prior";
      const recovered = {
        ...entry,
        restartRecoveryDeliveryRunId: recoveryRunId,
        restartRecoveryRuns:
          scenario === "prior"
            ? [{ runId: priorRunId, lifecycleGeneration: "retired-gateway" }]
            : [],
      };
      await replaceSessionEntry(target, recovered);
      const guard = createHarnessCompletionSourceAssertion({
        claim,
        storePath: target.storePath,
      });
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          agentId: "main",
          runId: recoveryRunId,
          ingress: { kind: "system", boundary: "test-recorder-recovery", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(recoveryRunId),
        assertSourceCurrent: guard,
      });
      try {
        const context = await admission.admit("embedded");
        const assertion = resolveAdmittedRunActiveAssertion(context);
        assert(assertion, "Missing real delegated effect authority");
        const effect = () =>
          runWithAgentToolSourceExecutionScope(assertion, async () => assertion());
        await effect();
        const inputRunId =
          scenario === "prior" || scenario === "unadmitted-prior" ? priorRunId : recoveryRunId;
        const provenance =
          scenario === "human"
            ? undefined
            : {
                kind: "internal_system" as const,
                sourceTool: "main_session_restart_recovery",
                sourceSessionKey:
                  scenario === "foreign-source" ? "agent:main:other" : requesterSessionKey,
              };
        const recorder = createUserTurnTranscriptRecorder({
          target: { ...transcript, sessionEntry: recovered },
          input: {
            text: "Continue the interrupted task",
            idempotencyKey: `${inputRunId}:user`,
            senderIsOwner: false,
            ...(provenance && { provenance }),
          },
          updateMode: "none",
        });
        const persisted = await recorder.persistApproved();
        expect(persisted?.appended).toBe(true);
        expect(persisted?.message.idempotencyKey).toBe(`${inputRunId}:user`);
        expect(persisted?.message["__openclaw"]?.runId).toBeUndefined();
        if (scenario === "current" || scenario === "prior") {
          await expect(effect()).resolves.toBeUndefined();
        } else {
          await expect(effect()).rejects.toThrow();
        }
      } finally {
        admission.close();
      }
    });
  },
);
