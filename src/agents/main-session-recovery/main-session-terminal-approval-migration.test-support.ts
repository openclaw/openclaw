import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { migrateLegacyMainSessionKeys } from "../../config/sessions/legacy-main-session-migration.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getOperatorApprovalDetailed } from "../../gateway/operator-approval-store.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";

type RecoveryTarget = { agentId: string; sessionKey: string; storePath: string };

export async function stageMigratingApprovalSource(
  target: RecoveryTarget,
  sourceRunId: string,
  message: PersistedUserTurnMessage,
): Promise<void> {
  const scope = { ...target, sessionId: "main-session" };
  const input = expectDefined(
    await stageSessionPendingInput(scope, { runId: sourceRunId, message, assertCurrent: () => {} }),
    "accepted source before Doctor migration",
  );
  try {
    expect(
      await input.run(() => appendTranscriptMessage(scope, { message: input.message })),
    ).toMatchObject({ appended: true });
  } finally {
    input.finish("interrupted");
    await input.settled?.();
  }
}

export async function migrateTerminalApprovalSource(target: RecoveryTarget, sourceRunId: string) {
  const original = expectDefined(loadSessionEntry(target), "original main-owned recovery entry");
  const cfg: OpenClawConfig = { agents: { entries: { ops: {} } } };
  expect(await migrateLegacyMainSessionKeys({ cfg, mode: "doctor-fix" })).toMatchObject({
    complete: true,
    ownerAgentId: "ops",
    outcomes: [expect.objectContaining({ kind: "migrated-cross-store" })],
  });
  const migrated = {
    agentId: "ops",
    sessionKey: "agent:ops:main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "ops" }),
  };
  expect(loadSessionEntry(target)).toBeUndefined();
  expect(loadSessionEntry(migrated)).toMatchObject(original);
  expect(await getOperatorApprovalDetailed({ id: "stream-proposal" })).toMatchObject({
    outcome: "found",
    record: {
      source: {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        sessionId: original.sessionId,
        runId: sourceRunId,
      },
      status: "cancelled",
      terminalReason: "gateway-restart",
      consumedAtMs: null,
      consumedBy: null,
    },
  });
  return { target: migrated, cfg };
}
