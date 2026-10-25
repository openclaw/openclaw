import { createHash } from "node:crypto";
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardExecution,
  WorkboardExecutionStatus,
  WorkboardLaunchState,
  WorkboardMetadata,
  WorkboardStaleState,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import {
  buildWorkerContext,
  assertCanMutateClaimedCard,
  cardBoardId,
  cardParentIds,
  cardRunId,
  cardSessionKey,
  computeCardDiagnostics,
  mergeDiagnostics,
  shouldSkipPersistedLifecycleStatusUpdate,
  shouldSyncWorkboardLifecycleStatus,
} from "./store-card-helpers.js";
import { WorkboardDispatchStore } from "./store-dispatch.js";
import type {
  WorkboardBulkInput,
  WorkboardDiagnosticsResult,
  WorkboardMutationScope,
  WorkboardOwnedCardPatch,
} from "./store-inputs.js";
import { capText } from "./store-normalizers.js";
import { readCards } from "./store-read.js";

export type { WorkboardDispatchResult } from "./store-inputs.js";
export { WorkboardCardConflictError } from "./store-core.js";

const log = createSubsystemLogger("workboard");

type WorkboardExecutionAssociationInput = {
  expectedSessionKey?: string;
  expectedRunId?: string;
  sessionKey: string;
  runId?: string;
  execution: WorkboardExecution;
};
type WorkboardExecutionAssociationPatchInput = WorkboardExecutionAssociationInput & {
  launch?: WorkboardLaunchState;
};

type WorkboardLifecycleAssociation = Omit<WorkboardExecutionAssociationInput, "execution"> & {
  acceptedAt?: number;
};
type WorkboardExecutionAssociationPatch = WorkboardOwnedCardPatch & {
  metadata?: WorkboardMetadata;
};
type WorkboardPreparedLaunch = Extract<WorkboardLaunchState, { phase: "prepared" }>;

function intentProvisionalRunId(cardId: string, intentRunId: string): string {
  if (!/^wb-[0-9a-f]{40}$/.test(intentRunId)) {
    throw new Error("intentRunId must be a wb-<40 lowercase hex> dispatch intent id.");
  }
  const digest = createHash("sha256").update(cardId).update("\0").update(intentRunId).digest("hex");
  return `workboard:intent:${digest}`;
}

function preparedLaunchMatchesCard(
  card: WorkboardCard,
  expected: WorkboardPreparedLaunch,
): boolean {
  const launch = card.metadata?.automation?.launch;
  return (
    launch?.phase === "prepared" &&
    launch.requestedSessionKey === expected.requestedSessionKey &&
    launch.provisionalRunId === expected.provisionalRunId &&
    launch.preparedAt === expected.preparedAt &&
    card.sessionKey === expected.requestedSessionKey &&
    card.runId === expected.provisionalRunId &&
    card.execution?.sessionKey === expected.requestedSessionKey &&
    card.execution?.runId === expected.provisionalRunId
  );
}

function acceptedLaunchForAssociation(
  card: WorkboardCard,
  association: WorkboardLifecycleAssociation,
): WorkboardLaunchState | undefined {
  const launch = card.metadata?.automation?.launch;
  if (launch?.phase === "prepared") {
    if (
      !preparedLaunchMatchesCard(card, launch) ||
      association.acceptedAt === undefined ||
      association.acceptedAt < launch.preparedAt
    ) {
      return undefined;
    }
    return {
      ...launch,
      phase: "accepted",
      acceptedAt: association.acceptedAt,
      acceptedSessionKey: association.sessionKey,
      ...(association.runId ? { acceptedRunId: association.runId } : {}),
    };
  }
  if (
    launch?.phase !== "accepted" ||
    (launch.acceptedSessionKey === association.sessionKey &&
      (!association.runId || launch.acceptedRunId === association.runId))
  ) {
    return undefined;
  }
  return {
    ...launch,
    acceptedSessionKey: association.sessionKey,
    ...(association.runId ? { acceptedRunId: association.runId } : {}),
  };
}

function executionAssociationPatch(
  card: WorkboardCard,
  input: WorkboardExecutionAssociationPatchInput,
): WorkboardExecutionAssociationPatch | undefined {
  if (
    cardSessionKey(card) !== input.expectedSessionKey ||
    cardRunId(card) !== input.expectedRunId
  ) {
    return undefined;
  }
  const attempts = [...(card.metadata?.attempts ?? [])];
  const attemptIndex = attempts.findLastIndex(
    (attempt) =>
      attempt.status === "running" &&
      ((input.expectedRunId && attempt.runId === input.expectedRunId) ||
        (!input.expectedRunId &&
          input.expectedSessionKey &&
          attempt.sessionKey === input.expectedSessionKey)),
  );
  if (attemptIndex >= 0) {
    const attempt = attempts[attemptIndex];
    if (attempt) {
      attempts[attemptIndex] = {
        ...attempt,
        sessionKey: input.sessionKey,
        ...(input.runId ? { runId: input.runId } : {}),
      };
    }
  }
  return {
    sessionKey: input.sessionKey,
    ...(input.runId ? { runId: input.runId } : {}),
    execution: input.execution,
    ownedLaunch: input.launch,
    ...(attemptIndex >= 0 ? { metadata: { ...card.metadata, attempts } } : {}),
  };
}

function claimPostdatesLaunch(
  claim: WorkboardClaim | undefined,
  launch: WorkboardLaunchState | undefined,
): boolean {
  return Boolean(claim && launch && claim.claimedAt > launch.preparedAt);
}

function hasExactTerminalClaimAssociation(
  card: WorkboardCard,
  claim: WorkboardClaim | undefined,
  launch: WorkboardLaunchState | undefined,
  input: {
    targetStatus: WorkboardStatus | undefined;
    executionStatus: WorkboardExecutionStatus | undefined;
    association?: WorkboardLifecycleAssociation;
  },
): boolean {
  const association = input.association;
  const sessionKey = cardSessionKey(card);
  const runId = cardRunId(card);
  const terminalStatusMatches =
    (input.targetStatus === "review" && input.executionStatus === "review") ||
    (input.targetStatus === "blocked" && input.executionStatus === "blocked");
  return Boolean(
    terminalStatusMatches &&
    association?.runId &&
    claim &&
    launch?.phase === "accepted" &&
    launch.acceptedSessionKey === association.sessionKey &&
    launch.acceptedRunId === association.runId &&
    claim.claimedAt <= launch.preparedAt &&
    sessionKey &&
    runId &&
    association.expectedSessionKey === sessionKey &&
    association.expectedRunId === runId,
  );
}

// Capability layers share persistence handles and the runtime's mutation ordering.
export class WorkboardStore extends WorkboardDispatchStore {
  async prepareExecutionLaunch(
    id: string,
    input: {
      requestedSessionKey: string;
      now: number;
      scope: WorkboardMutationScope;
      assertOwnerCurrent?: () => void;
      intentRunId?: string;
    },
  ): Promise<{ card: WorkboardCard; launch: WorkboardPreparedLaunch }> {
    const intentKey =
      input.intentRunId === undefined ? undefined : intentProvisionalRunId(id, input.intentRunId);
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (card) => {
        assertCanMutateClaimedCard(card, input.scope);
        const provisionalRunId = intentKey ?? `workboard:${card.id}:${card.updatedAt}`;
        const launch: WorkboardPreparedLaunch = {
          phase: "prepared",
          requestedSessionKey: input.requestedSessionKey,
          provisionalRunId,
          preparedAt: card.updatedAt,
        };
        return {
          sessionKey: input.requestedSessionKey,
          runId: provisionalRunId,
          execution: {
            id: card.execution?.id ?? `${card.id}:agent-session`,
            kind: "agent-session",
            mode: "autonomous",
            status: "running",
            sessionKey: input.requestedSessionKey,
            runId: provisionalRunId,
            startedAt: input.now,
            updatedAt: input.now,
          },
          ownedLaunch: launch,
        };
      });
      const launch = result.card.metadata?.automation?.launch;
      if (launch?.phase !== "prepared") {
        throw new Error("prepared Workboard launch was not persisted");
      }
      return { card: result.card, launch };
    }, input.assertOwnerCurrent);
  }

  async acceptExecutionLaunch(
    id: string,
    input: WorkboardExecutionAssociationInput & {
      expectedLaunch: WorkboardPreparedLaunch;
      acceptedAt: number;
    },
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (card) => {
        if (
          !preparedLaunchMatchesCard(card, input.expectedLaunch) ||
          input.acceptedAt < input.expectedLaunch.preparedAt
        ) {
          return undefined;
        }
        const launch: WorkboardLaunchState = {
          ...input.expectedLaunch,
          phase: "accepted",
          acceptedAt: input.acceptedAt,
          acceptedSessionKey: input.sessionKey,
          ...(input.runId ? { acceptedRunId: input.runId } : {}),
        };
        return executionAssociationPatch(card, { ...input, launch });
      });
      return result.updated ? result.card : undefined;
    });
  }

  async failPreparedLaunch(
    id: string,
    input: { expectedLaunch: WorkboardPreparedLaunch; reason: string; failedAt: number },
  ): Promise<boolean> {
    const failedAt = Math.max(input.failedAt, input.expectedLaunch.preparedAt);
    const reason = capText(input.reason, 2000) ?? "Dispatcher could not start worker.";
    const launchReason = capText(reason, 800) ?? "Prepared launch failed.";
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (card) => {
        if (!preparedLaunchMatchesCard(card, input.expectedLaunch)) {
          return undefined;
        }
        const blocked = this.buildBlockedCardPatch(card, reason, failedAt, {
          clearExecutionAssociation: true,
        });
        return {
          ...blocked,
          ownedLaunch: {
            ...input.expectedLaunch,
            phase: "failed",
            failedAt,
            reason: launchReason,
          },
        };
      });
      return result.updated;
    });
  }

  async syncLifecycle(
    id: string,
    input: {
      targetStatus: WorkboardStatus | undefined;
      executionStatus: WorkboardExecutionStatus | undefined;
      sourceUpdatedAt: number | undefined;
      stale: WorkboardStaleState | undefined;
      now: number;
      association?: WorkboardLifecycleAssociation;
    },
  ): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(id, (card) => {
        if (card.metadata?.archivedAt) {
          return undefined;
        }
        const patch: WorkboardOwnedCardPatch = {};
        let metadata: Record<string, unknown> | undefined;
        const launch = card.metadata?.automation?.launch;
        const association = input.association;
        // Run IDs fence late hooks even while a retry is prepared. Runless recovery
        // observations belong to the accepted launch only while its session is linked.
        const retiredAttempt =
          launch &&
          association &&
          card.metadata?.attempts?.findLast(
            (attempt) =>
              attempt.status === "blocked" &&
              (association.runId
                ? attempt.runId === association.runId
                : launch.phase === "accepted" &&
                  launch.acceptedSessionKey === association.sessionKey &&
                  attempt.runId === launch.acceptedRunId),
          );
        if (retiredAttempt) {
          log.info("Ignored lifecycle observation for a retired Workboard attempt", {
            cardId: card.id,
            attemptId: retiredAttempt.id,
            runId: retiredAttempt.runId,
          });
          return undefined;
        }
        const associationIsCurrent =
          !input.association ||
          (!claimPostdatesLaunch(card.metadata?.claim, launch) &&
            (input.sourceUpdatedAt === undefined ||
              !shouldSkipPersistedLifecycleStatusUpdate(card, input.sourceUpdatedAt)) &&
            (launch?.phase !== "prepared" ||
              (input.association.acceptedAt !== undefined &&
                input.association.acceptedAt >= launch.preparedAt)) &&
            cardSessionKey(card) === input.association.expectedSessionKey &&
            cardRunId(card) === input.association.expectedRunId);
        if (!associationIsCurrent) {
          return undefined;
        }
        if (
          input.sourceUpdatedAt !== undefined &&
          shouldSyncWorkboardLifecycleStatus(card, input.targetStatus)
        ) {
          patch.status = input.targetStatus;
          metadata = { lifecycleStatusSourceUpdatedAt: input.sourceUpdatedAt };
        }
        const acceptedLaunch = input.association
          ? acceptedLaunchForAssociation(card, input.association)
          : undefined;
        const associationNeedsUpdate =
          input.association &&
          (card.sessionKey !== input.association.sessionKey ||
            (input.association.runId !== undefined && card.runId !== input.association.runId) ||
            !card.execution ||
            card.execution.sessionKey !== input.association.sessionKey ||
            (input.association.runId !== undefined &&
              card.execution.runId !== input.association.runId) ||
            (input.executionStatus !== undefined &&
              card.execution.status !== input.executionStatus) ||
            Boolean(acceptedLaunch));
        if (input.association && associationNeedsUpdate) {
          const existing = card.execution;
          const runId = input.association.runId ?? existing?.runId;
          const execution: WorkboardExecution = {
            id: existing?.id ?? `${card.id}:agent-session`,
            kind: "agent-session",
            mode: existing?.mode ?? "autonomous",
            status: input.executionStatus ?? existing?.status ?? "running",
            ...(existing?.engine ? { engine: existing.engine } : {}),
            ...(existing?.model ? { model: existing.model } : {}),
            sessionKey: input.association.sessionKey,
            ...(runId ? { runId } : {}),
            startedAt: existing?.startedAt ?? card.startedAt ?? card.updatedAt,
            updatedAt: input.now,
          };
          const associationPatch = executionAssociationPatch(card, {
            ...input.association,
            execution,
            ...(acceptedLaunch ? { launch: acceptedLaunch } : {}),
          });
          if (associationPatch) {
            Object.assign(patch, associationPatch);
            metadata = { ...associationPatch.metadata, ...metadata };
          }
        } else if (
          !input.association &&
          card.execution &&
          input.executionStatus &&
          card.execution.status !== input.executionStatus
        ) {
          patch.execution = {
            ...card.execution,
            status: input.executionStatus,
            updatedAt: input.now,
          };
        }
        if (input.stale) {
          const existing = card.metadata?.stale;
          if (
            !existing ||
            existing.lastSessionUpdatedAt !== input.stale.lastSessionUpdatedAt ||
            existing.reason !== input.stale.reason
          ) {
            metadata = {
              ...metadata,
              stale: {
                ...input.stale,
                detectedAt: existing?.detectedAt ?? input.stale.detectedAt,
              },
            };
          }
        } else if (card.metadata?.stale) {
          metadata = { ...metadata, stale: null };
        }
        if (
          associationIsCurrent &&
          hasExactTerminalClaimAssociation(
            card,
            card.metadata?.claim,
            acceptedLaunch ?? launch,
            input,
          )
        ) {
          metadata = { ...metadata, claim: undefined };
        }
        if (metadata) {
          patch.metadata = metadata;
        }
        return Object.keys(patch).length === 0 ? undefined : patch;
      });
      return result.updated;
    });
  }

  async prepareStart(
    id: string,
    now = Date.now(),
    assertOwnerCurrent?: () => void,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () => await this.promoteDependencyReady(await this.requireCard(id), now),
      assertOwnerCurrent,
    );
  }

  async bulkUpdate(input: WorkboardBulkInput): Promise<{ cards: WorkboardCard[] }> {
    const ids = Array.isArray(input.ids)
      ? input.ids.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      : [];
    if (ids.length === 0) {
      throw new Error("ids are required.");
    }
    const patch = asNonArrayRecord(input.patch);
    const cards: WorkboardCard[] = [];
    for (const id of ids) {
      const updated =
        input.archived === undefined
          ? await this.update(id, patch)
          : await this.archive(id, input.archived);
      cards.push(updated);
    }
    return { cards };
  }

  async archive(
    id: string,
    archived: unknown,
    options: { expectedUpdatedAt?: number } = {},
  ): Promise<WorkboardCard> {
    const shouldArchive = archived !== false;
    return await this.updateMetadata(
      id,
      (existing) => ({
        ...existing.metadata,
        archivedAt: shouldArchive ? Date.now() : 0,
      }),
      options,
    );
  }

  async exportCards(): Promise<{
    cards: WorkboardCard[];
    attachments: WorkboardAttachment[];
    exportedAt: number;
  }> {
    const cards = await this.list();
    const attachments = cards.flatMap((card) => card.metadata?.attachments ?? []);
    return { cards, attachments, exportedAt: Date.now() };
  }

  async diagnostics(now = Date.now()): Promise<WorkboardDiagnosticsResult> {
    const cards = await this.list();
    const rows = cards.flatMap((card) => {
      const diagnostics = computeCardDiagnostics(card, now);
      return diagnostics.length ? [{ card, diagnostics }] : [];
    });
    return {
      diagnostics: rows,
      count: rows.reduce((total, row) => total + row.diagnostics.length, 0),
    };
  }

  async refreshDiagnostics(now = Date.now()): Promise<WorkboardDiagnosticsResult> {
    return await this.enqueueMutation(async () => {
      const cards = await this.list();
      const rows: WorkboardDiagnosticsResult["diagnostics"] = [];
      for (const card of cards) {
        let diagnostics: WorkboardDiagnostic[] = [];
        const result = await this.updateLatestCard(card.id, (current) => {
          if (current.metadata?.archivedAt) {
            return undefined;
          }
          diagnostics = mergeDiagnostics(
            current.metadata?.diagnostics,
            computeCardDiagnostics(current, now),
          );
          if (diagnostics.length === 0 && !current.metadata?.diagnostics?.length) {
            return undefined;
          }
          return { metadata: { ...current.metadata, diagnostics } };
        });
        if (diagnostics.length > 0) {
          rows.push({ card: result.card, diagnostics });
        }
      }
      return {
        diagnostics: rows,
        count: rows.reduce((total, row) => total + row.diagnostics.length, 0),
      };
    });
  }

  async buildWorkerContext(id: string, options: { relatedOnly?: boolean } = {}): Promise<string> {
    if (options.relatedOnly) {
      const card = await this.requireCard(id);
      const related = (
        await Promise.all(cardParentIds(card).map(async (parentId) => await this.get(parentId)))
      ).filter((entry): entry is WorkboardCard => entry !== undefined);
      return buildWorkerContext(card, related, { includeRecentAgentWork: false });
    }
    return (await this.readWithWorkerContext(id)).workerContext;
  }

  async readWithWorkerContext(id: string): Promise<{
    card: WorkboardCard;
    workerContext: string;
  }> {
    const card = await this.requireCard(id);
    const parentIds = cardParentIds(card);
    const relatedCards =
      parentIds.length > 0 || card.agentId
        ? await readCards(this.store, {
            kind: "worker-context",
            cardId: card.id,
            boardId: cardBoardId(card),
            agentId: card.agentId,
            parentIds,
          })
        : [];
    return { card, workerContext: buildWorkerContext(card, relatedCards) };
  }

  static openSqlite(workerModuleUrl: URL, options?: { lazy?: boolean }) {
    const stores = createWorkboardSqliteStores({ workerModuleUrl, ...options });
    return new WorkboardStore(stores.cards, stores);
  }
}
