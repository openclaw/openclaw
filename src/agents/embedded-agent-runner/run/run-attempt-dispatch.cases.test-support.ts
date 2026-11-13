import { assert, expect } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../../config/sessions/session-entry-codec.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context-store.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import type { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import type { AgentHarnessAttemptParamsV2 } from "../../harness/types.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { PreparedEmbeddedAttemptDispatchInput } from "./execution-context.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import type { createSourceTurnDispatchAssertions } from "./run-attempt-dispatch.source-turn.test-support.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

export function createDispatchSandboxBackend(id: string, workdir: string, runtimeId = id) {
  return {
    id,
    runtimeId,
    runtimeLabel: "Synthetic sandbox",
    workdir,
    buildExecSpec: async () => {
      throw new Error("unexpected exec");
    },
    runShellCommand: async () => {
      throw new Error("unexpected shell");
    },
  };
}

export async function dispatchFreshTranscriptSuccessor(
  input: PreparedEmbeddedAttemptDispatchInput,
  successorSourceTurn: ReturnType<typeof createSourceTurnDispatchAssertions>,
) {
  const { runId, agentId, config } = input.runInput.runParams;
  assert(config);
  assert(agentId);
  const successorRunId = `${runId}-successor`;
  const successorAdmission = prepareAgentRunAdmission({
    cfg: config,
    facts: {
      runId: successorRunId,
      agentId,
      ingress: { kind: "system", boundary: "owner-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(successorRunId),
  });
  const successorParams = {
    ...input.runInput.runParams,
    runId: successorRunId,
    abortSignal: new AbortController().signal,
    admittedRunContext: await successorAdmission.admit("plugin-harness", "owner-test"),
  };
  successorSourceTurn.stamp(successorParams);
  const successorGeneration = getAgentEventLifecycleGeneration();
  const successorLane = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => successorGeneration,
    getParams: () => successorParams,
    globalLane: "owner-dispatch-successor",
    initialQueuedLifecycleGeneration: successorGeneration,
    setLifecycleGeneration() {},
    setParams() {},
  });
  const successorClaim = await claimAgentSessionWriter({
    ...successorParams,
    sessionTarget: input.sessionPromptState.sessionTarget,
  });
  assert(successorClaim);
  try {
    await prepareAndDispatchEmbeddedRunAttempt({
      ...input,
      runInput: {
        ...input.runInput,
        runParams: successorParams,
        laneController: successorLane,
        lifecycleGeneration: successorGeneration,
      },
      sessionPromptState: {
        ...input.sessionPromptState,
        sessionWriterFence: {
          expectedLifecycleRevision: successorClaim.expectedLifecycleRevision,
          expectedWriterRunId: successorClaim.expectedWriterRunId,
        },
      },
    });
  } finally {
    successorAdmission.close();
  }
}

export async function assertDurableTranscriptRevocation(
  attempt: Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"],
  workspaceDir: string,
  revoke: () => void,
  rejection: string | Error = "Session target preparation outlived its attempt",
  retain = false,
) {
  assert(attempt.sessionId);
  assert(attempt.sessionFile);
  assert(attempt.preparedSessionTarget);
  const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
    attempt: { ...attempt, sessionId: attempt.sessionId, sessionFile: attempt.sessionFile },
    externalAbortController: { arm() {}, async throwIfFiredAfterPrepCleanup() {} },
  });
  let assertRejectedWrite: (() => Promise<void>) | undefined;
  try {
    expect(transcript.ownedTranscriptWriteContext.sessionActor?.actor.target.database.kind).toBe(
      "file",
    );
    await transcript.withOwnedTranscriptWrite(async () => {
      const target = transcript.ownedTranscriptWriteContext.sessionTarget;
      const manager = await SessionManager.openAsync(target, workspaceDir);
      const message = { role: "user" as const, content: "authorized append", timestamp: 1 };
      await manager.appendMessageAsync(message);
      const readEvents = () =>
        runWithoutOwnedSessionTranscriptWrites(() => loadTranscriptEventsSync(target));
      const readEntry = () =>
        runWithoutOwnedSessionTranscriptWrites(() => loadSessionEntry(target));
      const before = readEvents();
      const entryBefore = readEntry();
      expect(
        before.filter((entry) => isIndexedSessionEntry(entry) && entry.type === "message"),
      ).toEqual([expect.objectContaining({ message })]);
      expect(entryBefore?.activeWriterRunId).toBe(attempt.runId);
      revoke();
      const rejected = expect(
        manager.appendMessageAsync({ ...message, content: "revoked append" }),
      ).rejects;
      if (rejection instanceof Error) {
        await rejected.toBe(rejection);
      } else {
        await rejected.toThrow(rejection);
      }
      expect(readEvents()).toEqual(before);
      expect(readEntry()).toEqual(entryBefore);
      assertRejectedWrite = async () => {
        const currentEvents = readEvents();
        const currentEntry = readEntry();
        await expect(
          transcript.withOwnedTranscriptWrite(() =>
            manager.appendMessageAsync({
              ...message,
              content: "late retired append",
            }),
          ),
        ).rejects.toThrow();
        expect(readEvents()).toEqual(currentEvents);
        expect(readEntry()).toEqual(currentEntry);
      };
    });
    assert(assertRejectedWrite);
    return { assertRejectedWrite, dispose: () => transcript.transcriptLifecycle.dispose() };
  } finally {
    if (!retain || !assertRejectedWrite) {
      await transcript.transcriptLifecycle.dispose();
    }
  }
}

export async function assertFreshTranscriptAfterRetirement(
  attempt: Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"],
  workspaceDir: string,
  assertRetired: () => Promise<void>,
) {
  assert(attempt.sessionId);
  assert(attempt.sessionFile);
  const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
    attempt: { ...attempt, sessionId: attempt.sessionId, sessionFile: attempt.sessionFile },
    externalAbortController: { arm() {}, async throwIfFiredAfterPrepCleanup() {} },
  });
  try {
    await transcript.withOwnedTranscriptWrite(async () => {
      const target = transcript.ownedTranscriptWriteContext.sessionTarget;
      const manager = await SessionManager.openAsync(target, workspaceDir);
      const message = { role: "user" as const, content: "fresh successor append", timestamp: 2 };
      await manager.appendMessageAsync(message);
      await assertRetired();
      attempt.preparedSessionTarget!.assertCurrent();
      await manager.appendMessageAsync({ ...message, content: "successor still writable" });
      const events = runWithoutOwnedSessionTranscriptWrites(() => loadTranscriptEventsSync(target));
      expect(
        events.flatMap((entry) =>
          isIndexedSessionEntry(entry) && entry.type === "message" ? [entry.message] : [],
        ),
      ).toEqual(
        ["authorized append", "fresh successor append", "successor still writable"].map((content) =>
          expect.objectContaining({ role: "user", content }),
        ),
      );
      expect(
        runWithoutOwnedSessionTranscriptWrites(() => loadSessionEntry(target))?.activeWriterRunId,
      ).toBe(attempt.runId);
    });
  } finally {
    await transcript.transcriptLifecycle.dispose();
  }
}

type DispatchCase = {
  cyberAccessProgram?: AgentHarnessAttemptParamsV2["cyberAccessProgram"];
  agentId?: string;
  sandboxSessionKey?: string;
  remoteSkills?: boolean;
  skillCatalog?: "host" | "sandbox" | "none";
  oneShotCliRun?: boolean;
  managedWorkspace?: boolean;
  explicitCwd?: boolean;
  realManagedWorkspace?: boolean;
  hostMedia?: "allowed" | "outside";
  retirePlacement?: boolean;
  configuredContextEngine?: boolean;
  diffBaseline?: "settled" | "failed" | "revoked";
  retryCount?: number;
  legacyRetryCount?: number;
  legacyRetryDelayMs?: number;
  retryPreparation?: "omit" | "mutate" | "change-cwd";
  cancelTrajectory?: boolean;
  preparedAuth?: "explicit-header" | "no-auth";
  transcriptTargetInvalidation?:
    | "closed"
    | "replaced"
    | "target"
    | "policy"
    | "stopped"
    | "restart"
    | "identity"
    | "source-closed";
  targetField?: "agentId" | "sessionId" | "sessionKey" | "storePath" | "threadId";
};

export const dispatchCases: DispatchCase[] = [
  ...(
    ["closed", "replaced", "policy", "stopped", "restart", "identity", "source-closed"] as const
  ).map((transcriptTargetInvalidation) => ({
    agentId: "main",
    transcriptTargetInvalidation,
  })),
  ...(["agentId", "sessionId", "sessionKey", "storePath", "threadId"] as const).map(
    (targetField) => ({
      agentId: "main",
      transcriptTargetInvalidation: "target" as const,
      targetField,
    }),
  ),
  { agentId: "main", cyberAccessProgram: "standard" },
  { agentId: "main", cyberAccessProgram: "daybreak_blue" },
  ...(["explicit-header", "no-auth"] as const).map((preparedAuth) => ({
    agentId: "main",
    preparedAuth,
  })),
  { agentId: "main", cancelTrajectory: true },
  ...(["settled", "failed", "revoked"] as const).map((diffBaseline) => ({
    sandboxSessionKey: "global",
    diffBaseline,
  })),
  {
    agentId: "main",
    skillCatalog: "host" as const,
    configuredContextEngine: true,
    retryCount: 0,
    legacyRetryCount: 9,
  },
  ...([0, undefined] as const).map((retryCount) => ({
    agentId: "main",
    retryCount,
    legacyRetryCount: 3,
    retryPreparation: "mutate" as const,
  })),
  ...(["omit", "change-cwd"] as const).map((retryPreparation) => ({
    agentId: "main",
    retryCount: 0,
    legacyRetryCount: 3,
    retryPreparation,
  })),
  {
    agentId: "main",
    explicitCwd: true,
    retryCount: 0,
    legacyRetryCount: 9,
  },
  {
    sandboxSessionKey: "global",
    skillCatalog: "sandbox" as const,
    oneShotCliRun: true,
    retryCount: 1,
  },
  {
    sandboxSessionKey: "agent:main:policy",
    oneShotCliRun: false,
    legacyRetryCount: 3,
    legacyRetryDelayMs: 12,
  },
  {
    oneShotCliRun: false,
    managedWorkspace: true,
    retryCount: 0,
    legacyRetryCount: 9,
  },
  {
    oneShotCliRun: false,
    managedWorkspace: true,
    realManagedWorkspace: true,
  },
  {
    agentId: "main",
    remoteSkills: true,
    oneShotCliRun: false,
    retirePlacement: true,
  },
  ...(["allowed", "outside"] as const).map((hostMedia) => ({
    remoteSkills: true,
    oneShotCliRun: false,
    managedWorkspace: true,
    realManagedWorkspace: true,
    hostMedia,
  })),
];
