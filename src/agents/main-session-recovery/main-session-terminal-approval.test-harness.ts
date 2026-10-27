import { expect, it } from "vitest";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import {
  recoverOperatorApprovalsOnStartup,
  consumeOperatorApprovalAllowOnce,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../../gateway/operator-approval-store.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.metadata.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import {
  migrateTerminalApprovalSource,
  stageMigratingApprovalSource,
} from "./main-session-terminal-approval-migration.test-support.js";

type TerminalApprovalFixture = {
  stateDir: () => string;
  makeControlUiRecoveryFixture: (overrides?: SessionEntryFixture) => Promise<{
    sessionsDir: string;
    storePath: string;
    sessionKey: string;
  }>;
  writeTranscript: (sessionsDir: string, sessionId: string, messages: unknown[]) => Promise<void>;
  expectRecovery: (
    expected: { started: number; settled: number; failed: number; skipped: number },
    cfg?: OpenClawConfig,
  ) => Promise<void>;
  gatewayParams: () => Record<string, unknown>;
};

export function registerTerminalApprovalRecoveryCases(harness: TerminalApprovalFixture): void {
  it.each(["ordinary", "unpreclaimed", "migrated-owner"] as const)(
    "continues an interrupted mixed request while its cancelled stream approval stays closed (%s)",
    async (scenario) => {
      const sourceRunId = "control-ui-run";
      const userMessage = {
        role: "user" as const,
        content: "Watch build.log, and summarize README.md.",
        timestamp: 1,
        idempotencyKey: buildRunUserTurnIdempotencyKey(sourceRunId),
        __openclaw: { transport: { clients: [{ id: "openclaw-control-ui", mode: "ui" }] } },
      };
      await withEnvAsync({ OPENCLAW_STATE_DIR: harness.stateDir() }, async () => {
        const { sessionsDir, storePath, sessionKey } = await harness.makeControlUiRecoveryFixture(
          scenario === "unpreclaimed"
            ? {
                restartRecoveryDeliveryRequestFingerprint: undefined,
                restartRecoveryDeliveryRunId: undefined,
                restartRecoverySourceIngress: undefined,
              }
            : {},
        );
        try {
          if (scenario === "migrated-owner") {
            await stageMigratingApprovalSource(
              { agentId: "main", sessionKey, storePath },
              sourceRunId,
              userMessage,
            );
          }
          await harness.writeTranscript(sessionsDir, "main-session", [
            ...(scenario === "migrated-owner" ? [] : [userMessage]),
            { role: "assistant", content: [{ type: "text", text: "Waiting for approval." }] },
          ]);
          const now = Date.now();
          await insertOperatorApproval({
            approval: {
              id: "stream-proposal",
              kind: "exec",
              runtimeEpoch: "before-restart",
              source: {
                agentId: "main",
                sessionKey,
                sessionId: "main-session",
                runId: sourceRunId,
              },
              audienceSessionKeys: [sessionKey],
              createdAtMs: now,
              expiresAtMs: now + 60_000,
              presentation: {
                kind: "exec",
                commandText: "tail -F build.log",
                allowedDecisions: ["allow-once", "deny"],
                streamProposal: { jobId: "watcher-1", name: "Build log", operation: "add" },
              },
            },
          });
          await closeOpenClawStateDatabaseAsync();
          await recoverOperatorApprovalsOnStartup({
            runtimeEpoch: "after-restart",
            nowMs: now + 1,
          });
          const { target, cfg } =
            scenario === "migrated-owner"
              ? await migrateTerminalApprovalSource(
                  { agentId: "main", sessionKey, storePath },
                  sourceRunId,
                )
              : { target: { agentId: "main", sessionKey, storePath }, cfg: undefined };

          await harness.expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 }, cfg);
          expect(callGateway).toHaveBeenCalledOnce();
          const recoveryRunId = harness.gatewayParams().idempotencyKey;
          expect(recoveryRunId).toEqual(expect.any(String));
          expect(recoveryRunId).not.toBe(sourceRunId);
          const entry = loadSessionEntry(target);
          expect(entry).toMatchObject({
            abortedLastRun: false,
            lifecycleRunId: recoveryRunId,
            restartRecoveryDeliveryRunId: recoveryRunId,
            restartRecoveryDeliverySourceRunId: sourceRunId,
            mainRestartRecovery: { chargedAttempts: 1 },
          });
          expect(entry && hasRestartRecoveryTerminalRun(entry, sourceRunId)).toBe(false);
          await expect(
            resolveOperatorApproval({
              id: "stream-proposal",
              decision: "allow-once",
              resolver: { kind: "device", id: "reviewer" },
            }),
          ).resolves.toMatchObject({ outcome: "already-resolved", retry: "conflict" });
          await expect(
            consumeOperatorApprovalAllowOnce({
              id: "stream-proposal",
              consumerId: "resumed-proposal",
            }),
          ).resolves.toMatchObject({ outcome: "not-allow-once" });
          await expect(
            getOperatorApprovalDetailed({ id: "stream-proposal" }),
          ).resolves.toMatchObject({
            outcome: "found",
            record: {
              status: "cancelled",
              terminalReason: "gateway-restart",
              consumedAtMs: null,
              consumedBy: null,
            },
          });
        } finally {
          await closeOpenClawStateDatabaseAsync();
        }
      });
    },
  );
}
