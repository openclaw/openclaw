import { randomUUID } from "node:crypto";
import type {
  WorkboardArtifact,
  WorkboardAttachment,
  WorkboardCard,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardProof,
} from "@openclaw/workboard-contract";
import type { PersistedWorkboardAttachment } from "./persistence-types.js";
import {
  assertCanMutateClaimedCard,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
} from "./store-card-helpers.js";
import {
  MAX_CARD_ARTIFACTS,
  MAX_CARD_ATTACHMENTS,
  MAX_CARD_NOTIFICATIONS,
  MAX_CARD_PROOF,
  MAX_CARD_WORKER_LOGS,
} from "./store-constants.js";
import { WorkboardCoreStore } from "./store-core.js";
import type {
  WorkboardArtifactInput,
  WorkboardAttachmentInput,
  WorkboardCardPatch,
  WorkboardMutationScope,
  WorkboardProofInput,
  WorkboardProtocolViolationInput,
  WorkboardWorkerLogInput,
} from "./store-inputs.js";
import {
  capText,
  clearDiagnostics,
  normalizeArtifact,
  normalizeAttachmentInput,
  normalizeBoundedString,
  normalizeProofInput,
  workerLogEntry,
} from "./store-normalizers.js";

export class WorkboardEnrichmentStore extends WorkboardCoreStore {
  protected finishRun(
    card: WorkboardCard,
    status: "done" | "blocked",
    now: number,
    reason?: string,
  ): WorkboardCardPatch & { metadata: WorkboardMetadata } {
    const execution =
      card.execution?.status === "running"
        ? { ...card.execution, status, updatedAt: now }
        : card.execution;
    return {
      status,
      ...(execution ? { execution } : {}),
      metadata: {
        ...card.metadata,
        claim: undefined,
        attempts: closeRunningAttempts(
          card.metadata?.attempts,
          now,
          status === "done" ? "succeeded" : "blocked",
          reason,
        ),
        failureCount: status === "done" ? 0 : (card.metadata?.failureCount ?? 0) + 1,
      },
    };
  }

  protected appendNotification(
    metadata: WorkboardMetadata | undefined,
    now: number,
    notification: Omit<WorkboardNotification, "id" | "createdAt" | "sequence">,
  ): WorkboardNotification[] {
    return [
      ...(metadata?.notifications ?? []),
      {
        id: randomUUID(),
        createdAt: now,
        sequence: this.nextNotificationSequence(now),
        ...notification,
      },
    ].slice(-MAX_CARD_NOTIFICATIONS);
  }

  async addProof(
    id: string,
    input: WorkboardProofInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.addEvidence(id, scope, normalizeProofInput(input, Date.now()));
  }

  async addProofWithArtifact(
    id: string,
    proofInput: WorkboardProofInput,
    artifactInput: WorkboardArtifactInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const proof = normalizeProofInput(proofInput, now);
    const artifact = normalizeArtifact({ ...artifactInput, createdAt: now });
    if (!artifact) {
      throw new Error("artifact url or path is required.");
    }
    return await this.addEvidence(id, scope, proof, artifact);
  }

  async addArtifact(
    id: string,
    input: WorkboardArtifactInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const artifact = normalizeArtifact({ ...input, createdAt: Date.now() });
    if (!artifact) {
      throw new Error("artifact url or path is required.");
    }
    return await this.addEvidence(id, scope, undefined, artifact);
  }

  private addEvidence(
    id: string,
    scope: WorkboardMutationScope | undefined,
    proof?: WorkboardProof,
    artifact?: WorkboardArtifact,
  ): Promise<WorkboardCard> {
    return this.updateMetadata(
      id,
      (existing) => {
        assertCanMutateClaimedCard(existing, scope);
        const metadata = { ...clearDiagnostics(existing.metadata, ["missing_proof"]) };
        if (proof) {
          metadata.proof = [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF);
        }
        if (artifact) {
          metadata.artifacts = [...(metadata.artifacts ?? []), artifact].slice(-MAX_CARD_ARTIFACTS);
        }
        return metadata;
      },
      { preserveProofId: proof?.id },
    );
  }

  async addAttachment(
    id: string,
    input: WorkboardAttachmentInput,
    scope?: WorkboardMutationScope,
    assertCurrent?: () => void,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(id);
      assertCanMutateClaimedCard(existing, scope);
      const now = Date.now();
      const { attachment, contentBase64 } = normalizeAttachmentInput(id, input, now);
      // Blob storage and metadata publication are separate accepted writes. Each
      // needs live upload authority; rejection cleanup must not require it.
      await this.withMutationAuthority(
        () =>
          this.attachmentStore.register(attachment.id, {
            version: 1,
            attachment,
            contentBase64,
          }),
        assertCurrent,
      );
      try {
        const updated = await this.withMutationAuthority(
          async () =>
            this.updateCard(await this.requireCard(id), {
              metadata: {
                ...clearDiagnostics(existing.metadata, ["missing_proof"]),
                attachments: [...(existing.metadata?.attachments ?? []), attachment].slice(
                  -MAX_CARD_ATTACHMENTS,
                ),
              },
            }),
          assertCurrent,
        );
        if (!updated.metadata?.attachments?.some((entry) => entry.id === attachment.id)) {
          throw new Error("attachment metadata was trimmed before it could be indexed.");
        }
        return updated;
      } catch (error) {
        await this.attachmentStore.delete(attachment.id);
        throw error;
      }
    });
  }

  async listAttachments(id: string): Promise<{
    card: WorkboardCard;
    attachments: WorkboardAttachment[];
  }> {
    const card = await this.requireCard(id);
    return { card, attachments: card.metadata?.attachments ?? [] };
  }

  async getAttachment(id: string): Promise<PersistedWorkboardAttachment | undefined> {
    const attachmentId = id.trim();
    const entry = await this.attachmentStore.lookup(attachmentId);
    return entry?.version === 1 ? entry : undefined;
  }

  async deleteAttachment(
    cardId: string,
    attachmentId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.requireCard(cardId);
      assertCanMutateClaimedCard(existing, scope);
      const attachments = existing.metadata?.attachments ?? [];
      if (!attachments.some((attachment) => attachment.id === attachmentId)) {
        throw new Error(`attachment not found: ${attachmentId}`);
      }
      await this.attachmentStore.delete(attachmentId);
      return await this.updateCard(await this.requireCard(cardId), {
        metadata: {
          ...existing.metadata,
          attachments: attachments.filter((attachment) => attachment.id !== attachmentId),
        },
      });
    });
  }

  async addWorkerLog(
    id: string,
    input: WorkboardWorkerLogInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const message = normalizeBoundedString(input.message, undefined, 800, "worker log message");
    if (!message) {
      throw new Error("worker log message is required.");
    }
    const log = workerLogEntry(input, message, now);
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      return {
        ...existing.metadata,
        workerLogs: [...(existing.metadata?.workerLogs ?? []), log].slice(-MAX_CARD_WORKER_LOGS),
      };
    });
  }

  async recordProtocolViolation(
    id: string,
    input: WorkboardProtocolViolationInput = {},
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const card = await this.requireCard(id);
      assertCanMutateClaimedCard(card, scope);
      const now = Date.now();
      const detail =
        normalizeBoundedString(input.detail, undefined, 800, "protocol violation detail") ??
        "Worker stopped without completing or blocking the card.";
      const log = workerLogEntry({ ...input, level: "error" }, detail, now);
      const { sessionKey, runId } = log;
      const finished = this.finishRun(card, "blocked", now, detail);
      const notifications = this.appendNotification(card.metadata, now, {
        kind: "failed",
        message: capText(detail, 240) ?? "Worker protocol violation.",
        ...(sessionKey || cardSessionKey(card)
          ? { sessionKey: sessionKey ?? cardSessionKey(card) }
          : {}),
        ...(runId || cardRunId(card) ? { runId: runId ?? cardRunId(card) } : {}),
      });
      return await this.updateCard(await this.requireCard(card.id), {
        ...finished,
        status: card.status === "done" ? card.status : "blocked",
        metadata: {
          ...finished.metadata,
          workerLogs: [...(card.metadata?.workerLogs ?? []), log].slice(-MAX_CARD_WORKER_LOGS),
          workerProtocol: {
            state: "violated",
            updatedAt: now,
            detail,
          },
          notifications,
        },
      });
    });
  }
}
