import { assert, expect, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../../config/sessions/session-entry-codec.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context-store.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../../trajectory/runtime-store.sqlite.js";
import type { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import type { AgentHarnessAttemptParamsV2 } from "../../harness/types.js";
import { SessionManager } from "../../sessions/session-manager.js";
import * as memoryAudienceOwner from "./attempt-memory-audience.js";
import * as trajectoryOwner from "./attempt-trajectory.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import type { createEmbeddedRunLaneController } from "./lane-controller.js";
import * as progressWorkOwner from "./progress-work.js";

export async function assertDurableTranscriptRevocation(
  attempt: Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"],
  workspaceDir: string,
  revoke: () => void,
  invalidation: "target" | "policy",
) {
  assert(attempt.sessionId);
  assert(attempt.sessionFile);
  assert(attempt.preparedSessionTarget);
  const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
    attempt: { ...attempt, sessionId: attempt.sessionId, sessionFile: attempt.sessionFile },
    externalAbortController: { arm() {}, async throwIfFiredAfterPrepCleanup() {} },
  });
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
      await expect(
        manager.appendMessageAsync({ ...message, content: "revoked append" }),
      ).rejects.toThrow(
        invalidation === "target"
          ? "Session target changed during the outer run"
          : "Session target preparation outlived its attempt",
      );
      expect(readEvents()).toEqual(before);
      expect(readEntry()).toEqual(entryBefore);
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
  cancelHydration?: boolean;
  preparedAuth?: "explicit-header" | "no-auth";
  transcriptTargetInvalidation?: "closed" | "replaced" | "target" | "policy";
};

export const dispatchCases: DispatchCase[] = [
  ...(["closed", "replaced", "target", "policy"] as const).map((transcriptTargetInvalidation) => ({
    agentId: "main",
    transcriptTargetInvalidation,
  })),
  { agentId: "main", cyberAccessProgram: "standard" },
  { agentId: "main", cyberAccessProgram: "daybreak_blue" },
  ...(["explicit-header", "no-auth"] as const).map((preparedAuth) => ({
    agentId: "main",
    preparedAuth,
  })),
  { agentId: "main", cancelTrajectory: true },
  { agentId: "main", cancelHydration: true },
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

export function prepareHydrationCancellation(input: {
  cancellation: AbortController;
  cancellationError: Error;
  sessionId: string;
  storePath: string;
}) {
  const entered = createDeferred();
  const gate = createDeferred();
  const release = vi.fn();
  const audience = vi
    .spyOn(memoryAudienceOwner, "resolveEmbeddedAttemptMemoryAudience")
    .mockResolvedValue({ release });
  const prepare = trajectoryOwner.prepareEmbeddedHarnessTrajectory;
  const trajectory = vi
    .spyOn(trajectoryOwner, "prepareEmbeddedHarnessTrajectory")
    .mockImplementation(async (request) => {
      const recorder = await prepare(request);
      assert(recorder);
      recorder.recordEvent("hydration.accepted");
      return recorder;
    });
  const capture = progressWorkOwner.captureProgressWorkReader;
  const reader = vi
    .spyOn(progressWorkOwner, "captureProgressWorkReader")
    .mockImplementation((request) => {
      const retained = capture(request);
      return {
        ...retained,
        read: async () => {
          entered.resolve();
          await gate.promise;
          return retained.read();
        },
      };
    });
  return {
    settle: () => gate.resolve(),
    async expectCleanup(
      pending: Promise<unknown>,
      getControls: () =>
        | ReturnType<ReturnType<typeof createEmbeddedRunLaneController>["createAttemptControls"]>
        | undefined,
    ) {
      await awaitGateBeforeSettlement(entered.promise, pending, "Hydration was bypassed");
      const controls = getControls();
      assert(controls);
      using close = vi.spyOn(controls, "close");
      expect(controls.isAttemptCurrent()).toBe(true);
      expect(release).not.toHaveBeenCalled();
      input.cancellation.abort(input.cancellationError);
      gate.resolve();
      await expect(pending).rejects.toThrow("Session target preparation outlived its attempt");
      expect.soft(close).toHaveBeenCalledOnce();
      expect.soft(release).toHaveBeenCalledOnce();
      expect
        .soft(
          await loadSqliteTrajectoryRuntimeEvents({
            sessionId: input.sessionId,
            storePath: input.storePath,
          }),
        )
        .toEqual([expect.objectContaining({ type: "hydration.accepted", source: "runtime" })]);
    },
    [Symbol.dispose]() {
      gate.resolve();
      reader.mockRestore();
      audience.mockRestore();
      trajectory.mockRestore();
    },
  };
}
