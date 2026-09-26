import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";
import { buildCurrentRunRestartRecoveryClaim } from "./agent-command-restart-recovery.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask,
} from "./agent-harness-completion-recovery.js";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "./agent-harness-completion-scope.js";

const requesterSessionKey = "agent:main:main";
const sourceSessionKey = "native-child:one";
const sourceRunId = "announce:one";
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
      kind: "inter_session",
      sourceChannel: "internal",
      sourceTool: "agent_harness_completion",
      sourceSessionKey,
    },
  };
}
describe("native harness completion admission", () => {
  it("rejects forged provenance and structurally copied scopes", async () => {
    expect(() => captureHarnessCompletionRecovery(input())).toThrow("host-issued source admission");
    const scope = createAgentHarnessCompletionScope({
      requesterSessionKey,
      requesterAgentId: "main",
    });
    await expect(
      withAgentHarnessCompletionAdmission(
        {
          scope: { ...scope },
          sourceSessionKey,
          sourceRunId,
          requesterSessionId: "requester-one",
          requesterLifecycleRevision: "revision-one",
          isSourceCurrent: () => true,
        },
        async () => {},
      ),
    ).rejects.toThrow("host-issued scope");
  });
  it("transfers admitted source custody to its exact durable requester receipt without a task row", async () => {
    const params = input();
    const scope = createAgentHarnessCompletionScope({
      requesterSessionKey,
      requesterAgentId: "main",
    });
    const claim = await withAgentHarnessCompletionAdmission(
      {
        scope,
        sourceSessionKey,
        sourceRunId,
        requesterSessionId: params.entry.sessionId,
        requesterLifecycleRevision: params.entry.lifecycleRevision,
        isSourceCurrent: () => true,
      },
      async () => captureHarnessCompletionRecovery(params),
    );
    expect(claim).toBeDefined();
    if (!claim) {
      throw new Error("missing claim");
    }
    const restored = structuredClone(claim);
    expect(getOwedHarnessCompletionTask(restored, params.entry)).toBeUndefined();
    const saved = { ...params.entry, restartRecoveryHarnessCompletion: restored };
    expect(getOwedHarnessCompletionTask(restored, saved)).toEqual(restored);
    expect(
      getOwedHarnessCompletionTask(restored, { ...saved, sessionId: "replaced" }),
    ).toBeUndefined();
    expect(
      getOwedHarnessCompletionTask({ ...restored, requesterAgentId: "other" }, saved),
    ).toBeUndefined();
  });
  it("revalidates native source ownership after awaited work", async () => {
    const params = input();
    let current = true;
    const scope = createAgentHarnessCompletionScope({
      requesterSessionKey,
      requesterAgentId: "main",
    });
    await withAgentHarnessCompletionAdmission(
      {
        scope,
        sourceSessionKey,
        sourceRunId,
        requesterSessionId: params.entry.sessionId,
        requesterLifecycleRevision: params.entry.lifecycleRevision,
        isSourceCurrent: () => current,
      },
      async () => {
        await Promise.resolve();
        current = false;
        expect(() => captureHarnessCompletionRecovery(params)).toThrow("source owner retired");
      },
    );
  });
});

const key = requesterSessionKey,
  child = sourceSessionKey,
  source = sourceRunId;
async function setupNativeRequester(state: OpenClawTestState) {
  const target = {
    agentId: "main",
    sessionKey: key,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = {
    sessionId: "physical-one",
    lifecycleRevision: "revision-one",
    status: "running" as const,
    updatedAt: Date.now(),
  };
  await replaceSessionEntry(target, entry);
  return { target, entry };
}
async function captureForNativeRequester(
  params: Parameters<typeof captureHarnessCompletionRecovery>[0],
) {
  const scope = createAgentHarnessCompletionScope({
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
  });
  return await withAgentHarnessCompletionAdmission(
    {
      scope,
      sourceSessionKey: child,
      sourceRunId: params.runId,
      requesterSessionId: params.entry.sessionId,
      requesterLifecycleRevision: params.entry.lifecycleRevision,
      isSourceCurrent: () => true,
    },
    async () => captureHarnessCompletionRecovery(params),
  );
}
describe("pre-mirror recovery input custody", () => {
  it.each(["current", "prior", "unknown", "unadmitted-prior", "foreign-source", "human"] as const)(
    "retains exact pre-mirror recovery admission after the real recorder commits %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { target, entry: original } = await setupNativeRequester(state);
        const claim = await captureForNativeRequester({
          agentId: "main",
          sessionKey: key,
          entry: original,
          runId: source,
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "agent_harness_task",
            sourceChannel: "internal",
            sourceSessionKey: child,
          },
        });
        if (!claim) {
          throw new Error("real harness task did not bind at admission");
        }
        const entry = {
          ...original,
          ...buildCurrentRunRestartRecoveryClaim({
            entry: original,
            runId: source,
            sourceRunId: source,
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
            idempotencyKey: `${source}:user`,
            __openclaw: { runId: source },
            provenance: {
              kind: "inter_session",
              sourceTool: "agent_harness_task",
              sourceChannel: "internal",
              sourceSessionKey: child,
            },
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
          const effect = resolveAdmittedRunActiveAssertion(context);
          if (!effect) {
            throw new Error("Missing real delegated effect authority");
          }
          effect();
          const inputRunId =
            scenario === "prior" || scenario === "unadmitted-prior"
              ? priorRunId
              : scenario === "unknown"
                ? "unrelated-run"
                : recoveryRunId;
          const recorder = createUserTurnTranscriptRecorder({
            target: { ...transcript, sessionEntry: recovered },
            input: {
              text: "Continue the interrupted task",
              idempotencyKey: `${inputRunId}:user`,
              senderIsOwner: false,
              ...(scenario === "human"
                ? {}
                : {
                    provenance: {
                      kind: "internal_system" as const,
                      sourceTool: "main_session_restart_recovery",
                      sourceSessionKey: scenario === "foreign-source" ? "agent:main:other" : key,
                    },
                  }),
            },
            updateMode: "none",
          });
          const persisted = await recorder.persistApproved();
          expect(persisted?.appended).toBe(true);
          expect(persisted?.message.idempotencyKey).toBe(`${inputRunId}:user`);
          expect(persisted?.message["__openclaw"]?.runId).toBeUndefined();
          if (scenario === "current" || scenario === "prior") {
            expect(effect).not.toThrow();
          } else {
            expect(effect).toThrow();
          }
        } finally {
          admission.close();
        }
      });
    },
  );
});
