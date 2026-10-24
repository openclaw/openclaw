import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { assertCapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.js";
import { preparePhysicalSessionStorePath } from "../../config/sessions/session-store-path.js";
import {
  withOwnedSessionTranscriptWrites,
  type SessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { listTerminalOperatorApprovals } from "../../gateway/operator-approval-store.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { sanitizeForPromptLiteral } from "../sanitize-for-prompt.js";
import { appendSessionTranscriptNote } from "../sessions/session-manager-write-admission.js";

type RestartApprovalSource = {
  target: SessionTranscriptRuntimeTarget & { env?: Readonly<NodeJS.ProcessEnv> };
  sourceRunId: string;
  assertCurrent: () => void;
};

type RestartCancelledStreamProposal = {
  approvalId: string;
  jobId: string;
  name: string;
  operation: "add" | "update";
};

async function readRestartApprovalPage(params: RestartApprovalSource) {
  const history = await listTerminalOperatorApprovals({
    source: {
      sessionId: params.target.sessionId,
      runId: params.sourceRunId,
    },
    kind: "exec",
    limit: 8,
    databaseOptions: { env: params.target.env },
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  const proposals: RestartCancelledStreamProposal[] = history.records.flatMap((record) => {
    const proposal =
      record.presentation.kind === "exec" ? record.presentation.streamProposal : undefined;
    return proposal &&
      proposal.jobId.length <= 256 &&
      record.status === "cancelled" &&
      record.terminalReason === "gateway-restart" &&
      record.consumedAtMs === null &&
      record.consumedBy === null
      ? [{ approvalId: record.id, ...proposal }]
      : [];
  });
  return { proposals, nextCursor: history.nextCursor };
}

function formatRestartCancelledStreamProposal(proposal: RestartCancelledStreamProposal): string {
  const name = JSON.stringify(truncateUtf16Safe(sanitizeForPromptLiteral(proposal.name), 128));
  // Restart closes only pending approvals; stream registration follows rollback,
  // and saving the proposal consumes its approval in the same transaction.
  const effect =
    proposal.operation === "add"
      ? "This proposal did not create or change a watcher."
      : "The requested change was not saved; this proposal left the existing watcher unchanged.";
  return `Approval ${proposal.approvalId} for watcher ${name} (job ${JSON.stringify(proposal.jobId)}, ${proposal.operation}) was canceled when the Gateway restarted, while awaiting a decision. ${effect} This approval request is closed and cannot be approved.`;
}

async function readRestartApprovalOutcomes(params: RestartApprovalSource): Promise<string[]> {
  try {
    const history = await readRestartApprovalPage(params);
    return [
      ...(history.proposals.length
        ? [
            "Recorded outcomes for proposals from the interrupted run:",
            ...history.proposals.map(formatRestartCancelledStreamProposal),
            "These facts concern only those proposals; they do not establish whether other watchers exist or are running. These approval requests remain closed; any new proposal must follow the configured approval process.",
          ]
        : []),
      ...(history.nextCursor
        ? [
            "Only part of the retained approval history was checked; unlisted proposal outcomes remain unknown.",
          ]
        : []),
    ];
  } catch {
    params.assertCurrent();
    return [
      "Retained approval outcomes are unavailable. Earlier execution outcomes remain unknown unless separately verified.",
    ];
  }
}

/** Runtime-authored recovery outcome, not a grant or prediction about execution. */
export function formatRestartRecoveryAdmission(): string {
  return "OpenClaw admitted a continuation of this request after the Gateway restarted. Recovery did not grant new permission or confirm that earlier work finished.";
}

/** Retain the original physical source until the writer's recovery fact note settles. */
export async function withRestartRecoveryPresentation<
  T extends SessionTranscriptWriterFence,
>(params: {
  target: SessionTranscriptRuntimeTarget & { env?: Readonly<NodeJS.ProcessEnv> };
  runId: string;
  assertCurrent: () => void;
  claimWriter: () => Promise<T | undefined>;
}): Promise<T | undefined> {
  return withSessionEntryReadOnlyInWorker(
    params.target,
    params.assertCurrent,
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      if (read.value?.sessionId !== params.target.sessionId) {
        throw new Error("Restart recovery presentation lost its original session");
      }
      const source = owner.source;
      if (owner.kind === "file" && !source) {
        throw new Error("Restart recovery presentation has no captured physical source");
      }
      const assertCurrent = () => {
        owner.assertCurrent();
        if (owner.kind === "file" && source) {
          assertCapturedSessionEntryReadSource(source);
        }
      };
      assertCurrent();
      const claim = await params.claimWriter();
      assertCurrent();
      if (!claim) {
        throw new Error("Restart recovery presentation has no live writer claim");
      }
      const sourceRunId =
        read.value.restartRecoveryDeliveryRunId === params.runId
          ? read.value.restartRecoveryDeliverySourceRunId
          : undefined;
      const approvalOutcomes = sourceRunId
        ? await readRestartApprovalOutcomes({
            target: params.target,
            sourceRunId,
            assertCurrent,
          })
        : [];
      assertCurrent();
      await publishRestartRecoveryAdmission({
        ...params,
        approvalOutcomes,
        target: {
          ...params.target,
          expectedLifecycleRevision: claim.expectedLifecycleRevision,
          expectedWriterRunId: claim.expectedWriterRunId,
        },
        assertCurrent,
      });
      return claim;
    },
  );
}

/** The existing queue owner retains this write before either local or worker dispatch. */
async function publishRestartRecoveryAdmission(params: {
  target: SessionTranscriptRuntimeTarget &
    SessionTranscriptWriterFence & { env?: Readonly<NodeJS.ProcessEnv> };
  runId: string;
  approvalOutcomes: string[];
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  const target = {
    ...params.target,
    storePath: await preparePhysicalSessionStorePath(params.target),
  };
  params.assertCurrent();
  const message = {
    role: "custom" as const,
    customType: "restart-recovery-admission",
    content: [formatRestartRecoveryAdmission(), ...params.approvalOutcomes].join("\n\n"),
    display: true,
    timestamp: Date.now(),
    idempotencyKey: `restart-recovery-admission:${params.runId}`,
  };
  const persisted = await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: target,
      assertCommitAllowed: params.assertCurrent,
      withTranscriptWrite: trackAsyncWork,
    },
    () => appendSessionTranscriptNote(target, message),
  );
  params.assertCurrent();
  // The worker-prepared physical target needs no synchronous registry/SQLite lookup.
  emitSessionTranscriptUpdate({
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    target,
    ...(persisted.appended ? { message: persisted.message, messageId: persisted.messageId } : {}),
    runId: params.runId,
    lifecycleRevision: params.target.expectedLifecycleRevision,
  });
}
