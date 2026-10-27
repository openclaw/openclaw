import { assert, expect } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../../config/sessions/session-entry-codec.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context-store.js";
import type { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import type { AgentHarnessAttemptParamsV2 } from "../../harness/types.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";

export async function assertDurableTranscriptRevocation(
  attempt: Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"],
  workspaceDir: string,
  revoke: () => void,
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
      ).rejects.toThrow("Session target preparation outlived its attempt");
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
