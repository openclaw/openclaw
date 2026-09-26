import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  formatMemoryDreamingDay,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  appendConsolidationSkippedSummary,
  appendConsolidationSummary,
  readMemoryPreimages,
  storeMemoryPreimage,
} from "./dreaming-consolidation-artifacts.js";
import {
  isConsolidationCandidateEligible,
  isPromotionOriginBlocked,
} from "./dreaming-consolidation-candidates.js";
import { applyMemoryConsolidationPlan, consolidateMemory } from "./dreaming-consolidation.js";
import { buildBudgetedMemoryAppend } from "./memory-budget-append.js";
import { DEFAULT_MEMORY_FILE_MAX_CHARS } from "./memory-budget.js";
import { pruneMemoryEntryOrigins, reserveMemoryEntryOrigins } from "./memory-entry-origins.js";
import { readWorkspaceFile } from "./memory-workspace-files.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import {
  buildPromotionMarker,
  commitMemoryContent,
  extractPromotionKeys,
  hashMemoryContent,
  isAtomicReplacePermissionError,
  MemoryAtomicPublicationError,
  MemoryWriteConflictError,
  readMemoryContent,
  resolveMemoryWritePath,
} from "./short-term-promotion-memory-write.js";
import {
  buildPromotionRecallAnnotations,
  groupPromotionCandidatesByProjectKey,
} from "./short-term-promotion-metadata.js";
import { resolveShortTermSourcePathCandidates } from "./short-term-promotion-record.js";
import { rehydratePromotionCandidate } from "./short-term-promotion-rehydrate.js";
import { readStore, writeStore } from "./short-term-promotion-store.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  type ApplyShortTermPromotionsOptions,
  type ApplyShortTermPromotionsResult,
  type PromotionCandidate,
  type PromotionRejectionCategory,
  type ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
import {
  formatPromotedSnippetForMemory,
  isContaminatedDreamingSnippet,
  toFiniteNonNegativeInt,
  toFiniteScore,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const MEMORY_WRITE_LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
  stale: 120_000,
  staleRecovery: "fail-closed" as const,
};

function buildPromotionSection(
  candidates: PromotionCandidate[],
  nowMs: number,
  timezone?: string,
  maxPromotedSnippetTokens = DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
): string {
  const sectionDate = formatMemoryDreamingDay(nowMs, timezone);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];
  const projectGroups = groupPromotionCandidatesByProjectKey(candidates);

  for (const { projectKey, candidates: groupCandidates } of projectGroups) {
    if (projectGroups.length > 1) {
      lines.push(projectKey ? `### Project: ${projectKey}` : "### Global", "");
    }
    for (const candidate of groupCandidates) {
      const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
      const metadata = `[score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`;
      lines.push(buildPromotionMarker(candidate.key));
      // Cap only the visible MEMORY.md text. The recall store keeps the full
      // rehydrated snippet so ranking, provenance, and dream narratives remain
      // tied to the source entry instead of this presentation budget.
      lines.push(
        `- ${formatPromotedSnippetForMemory(candidate.snippet, maxPromotedSnippetTokens)} ${metadata} ${buildPromotionRecallAnnotations(candidate)}`,
      );
    }
    if (projectGroups.length > 1) {
      lines.push("");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function consolidationCandidateFingerprint(candidate: PromotionCandidate): string {
  return JSON.stringify({
    key: candidate.key,
    path: candidate.path,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    snippet: candidate.snippet,
    provenance: candidate.provenance,
    projectKey: candidate.projectKey,
  });
}

function withAuthoritativeProvenance(
  candidate: PromotionCandidate,
  provenance: PromotionCandidate["provenance"],
): PromotionCandidate {
  if (isPromotionOriginBlocked(candidate)) {
    return candidate;
  }
  const next = { ...candidate };
  if (provenance) {
    next.provenance = provenance;
  } else {
    delete next.provenance;
  }
  return next;
}

function withDailyFileQuarantine(
  candidate: PromotionCandidate,
  provenanceByPath: ReadonlyMap<
    string,
    { fileHash: string; originClass: "agent" | "untrusted"; observedAt: number }
  >,
): PromotionCandidate {
  const record = provenanceByPath.get(candidate.path.replaceAll("\\", "/"));
  if (record?.originClass !== "untrusted") {
    return candidate;
  }
  return {
    ...candidate,
    provenance: {
      originClass: "untrusted",
      sessionKind: candidate.provenance?.sessionKind ?? "unknown",
      observedAt: record.observedAt,
    },
  };
}

function recallStoreEntryFingerprint(entry: ShortTermRecallEntry | undefined): string {
  return JSON.stringify(entry ?? null);
}

async function promotionSourceFingerprint(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<string> {
  for (const sourcePath of resolveShortTermSourcePathCandidates(workspaceDir, candidate.path)) {
    try {
      const content = await readWorkspaceFile(workspaceDir, sourcePath);
      return createHash("sha256").update(content).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return "missing";
}

async function resolveMemoryPromotionLockTarget(workspaceDir: string): Promise<string> {
  const lockDir = path.join(resolveStateDir(), "locks");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const canonicalWorkspace = await fs
    .realpath(workspaceDir)
    .catch(() => path.resolve(workspaceDir));
  const workspaceHash = createHash("sha256").update(canonicalWorkspace).digest("hex");
  return path.join(lockDir, `memory-promotion-${workspaceHash}`);
}

export async function applyShortTermPromotions(
  options: ApplyShortTermPromotionsOptions,
): Promise<ApplyShortTermPromotionsResult> {
  const workspaceDir = options.workspaceDir.trim();
  const nowMs = resolveMemoryCoreNowMs(options.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit as number))
    : options.candidates.length;
  const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
  const minRecallCount = toFiniteNonNegativeInt(
    options.minRecallCount,
    DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  );
  const minUniqueQueries = toFiniteNonNegativeInt(
    options.minUniqueQueries,
    DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  );
  const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  const originAgentIds = options.agentId
    ? [...new Set([options.agentId, ...(options.workspaceAgentIds ?? [])])]
    : [];

  const dailyProvenanceEntries = await listMemoryArtifactProvenance({ workspaceDir });
  const dailyProvenanceByPath = new Map(
    dailyProvenanceEntries.map((entry) => [
      entry.relativePath.replaceAll("\\", "/"),
      entry.provenance,
    ]),
  );
  const store = await withMemoryWorkspaceLock(workspaceDir, async () =>
    readStore(workspaceDir, nowIso),
  );
  const currentCandidates = options.candidates.map((candidate) => {
    const entry = store.entries[candidate.key];
    const authoritative = entry
      ? withAuthoritativeProvenance(
          {
            ...candidate,
            path: entry.path,
            startLine: entry.startLine,
            endLine: entry.endLine,
            snippet: entry.snippet,
          },
          entry.provenance,
        )
      : candidate;
    // Flush quarantine is sticky at the daily-file boundary. This deliberately
    // sacrifices trusted lines in a mixed file so untrusted text cannot promote.
    return withDailyFileQuarantine(authoritative, dailyProvenanceByPath);
  });
  const rejections = new Map<string, { reason: string; category: PromotionRejectionCategory }>();
  const reject = (key: string, category: PromotionRejectionCategory, reason: string): false => {
    rejections.set(key, { category, reason });
    return false;
  };
  const describeRejection = (candidate: PromotionCandidate) => ({
    candidate,
    ...(rejections.get(candidate.key) ?? {
      // Late revalidation has several causes; do not attribute a more specific gate.
      category: "candidate changed" as const,
      reason: "candidate changed during apply",
    }),
  });
  const eligible = currentCandidates.filter((candidate) => {
    const latest = store.entries[candidate.key];
    // Explicit untrusted/system origins never promote on ANY path (append or
    // consolidation): recall frequency must never launder externally-derived
    // content into MEMORY.md. Workspace memory files index as 'agent', so
    // legitimate daily-note candidates stay eligible.
    return isPromotionOriginBlocked(candidate)
      ? reject(candidate.key, "origin", `origin filter (${candidate.provenance?.originClass})`)
      : options.consolidation && (!latest || !isConsolidationCandidateEligible(candidate))
        ? latest
          ? reject(
              candidate.key,
              "consolidation origin/session",
              "consolidation origin/session filter",
            )
          : false
        : isContaminatedDreamingSnippet(candidate.snippet)
          ? reject(candidate.key, "contamination", "contamination filter")
          : candidate.promotedAt || latest?.promotedAt
            ? reject(candidate.key, "already promoted", "already promoted")
            : candidate.score < minScore
              ? reject(
                  candidate.key,
                  "score threshold",
                  `score threshold (${candidate.score.toFixed(3)} < ${minScore})`,
                )
              : candidate.signalCount < minRecallCount
                ? reject(
                    candidate.key,
                    "signal threshold",
                    `signal threshold (${candidate.signalCount} < ${minRecallCount})`,
                  )
                : candidate.uniqueQueries < minUniqueQueries
                  ? reject(
                      candidate.key,
                      "query threshold",
                      `query threshold (${candidate.uniqueQueries} < ${minUniqueQueries})`,
                    )
                  : maxAgeDays >= 0 && candidate.ageDays > maxAgeDays
                    ? reject(
                        candidate.key,
                        "age threshold",
                        `age threshold (${candidate.ageDays.toFixed(1)}d > ${maxAgeDays}d)`,
                      )
                    : true;
  });
  const selected = eligible.slice(0, limit);
  for (const candidate of eligible.slice(limit)) {
    reject(candidate.key, "selection limit", `selection limit (${limit})`);
  }

  const rehydratedSelected: PromotionCandidate[] = [];
  const plannedSourceFingerprints = new Map<string, string>();
  for (const candidate of selected) {
    const sourceFingerprintBefore = await promotionSourceFingerprint(workspaceDir, candidate);
    const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidate);
    const sourceFingerprintAfter = await promotionSourceFingerprint(workspaceDir, candidate);
    // Integrity is guarded by source-fingerprint stability during rehydration,
    // successful rehydration (the snippet still exists in the live file), the
    // contamination check, and the origin block above. Rehydration is meant to
    // reshape the snippet (capping, heading context, moved lines), so we do not
    // additionally require the rehydrated text to equal the stored recall.
    if (
      sourceFingerprintBefore === sourceFingerprintAfter &&
      rehydrated &&
      !isContaminatedDreamingSnippet(rehydrated.snippet)
    ) {
      rehydratedSelected.push(rehydrated);
      plannedSourceFingerprints.set(candidate.key, sourceFingerprintAfter);
    } else {
      reject(
        candidate.key,
        !rehydrated
          ? "source rehydration"
          : sourceFingerprintBefore !== sourceFingerprintAfter
            ? "source changed"
            : "contamination",
        !rehydrated
          ? "source rehydration failed"
          : sourceFingerprintBefore !== sourceFingerprintAfter
            ? "source changed during apply"
            : "contamination filter after rehydration",
      );
    }
  }

  if (rehydratedSelected.length === 0) {
    return {
      memoryPath,
      applied: 0,
      appended: 0,
      reconciledExisting: 0,
      appliedCandidates: [],
      rejectedCandidates: currentCandidates.map(describeRejection),
      compactedSections: 0,
      compactedDates: [],
    };
  }

  const plannedStoreEntryFingerprints = new Map(
    rehydratedSelected.map((candidate) => [
      candidate.key,
      recallStoreEntryFingerprint(store.entries[candidate.key]),
    ]),
  );
  // Promotions historically follow user-managed MEMORY.md symlinks. Replace the
  // final target atomically without severing the chain, matching the prior writeFile path.
  let memoryWritePath = await resolveMemoryWritePath(memoryPath, workspaceDir);
  let existingMemory = await readMemoryContent(memoryWritePath, workspaceDir);
  let existingMarkers = new Set(extractPromotionKeys(existingMemory));
  let alreadyWritten = rehydratedSelected.filter((candidate) => existingMarkers.has(candidate.key));
  let toAppend = rehydratedSelected.filter((candidate) => !existingMarkers.has(candidate.key));
  const consolidationBaseMemoryHash = hashMemoryContent(existingMemory);
  const plannedCandidateFingerprints = new Map(
    toAppend.map((candidate) => [candidate.key, consolidationCandidateFingerprint(candidate)]),
  );

  let compactedDates: string[] = [];
  const budgetChars =
    typeof options.memoryFileMaxChars === "number" && Number.isFinite(options.memoryFileMaxChars)
      ? Math.max(0, Math.floor(options.memoryFileMaxChars))
      : DEFAULT_MEMORY_FILE_MAX_CHARS;
  const maxPriorEntryLossFraction = Math.max(
    0,
    Math.min(1, options.maxPriorEntryLossFraction ?? 0.25),
  );
  const consolidationPlan =
    options.agentId && options.consolidation?.subagent && toAppend.length > 0
      ? await consolidateMemory({
          agentId: options.agentId,
          subagent: options.consolidation.subagent,
          existingMemory,
          candidates: toAppend,
          ...(options.consolidation.model ? { model: options.consolidation.model } : {}),
          maxPriorEntryLossFraction,
          memoryFileMaxChars: budgetChars,
          ...(typeof options.maxPromotedSnippetTokens === "number"
            ? { maxPromotedSnippetTokens: options.maxPromotedSnippetTokens }
            : {}),
          nowMs,
          logger: options.consolidation.logger,
        })
      : null;
  let consolidationResult: Awaited<ReturnType<typeof applyMemoryConsolidationPlan>> = null;
  let committedCandidates: PromotionCandidate[] = [];
  let committedMemoryContent: string | undefined;
  let appendedCandidates = 0;
  let rewriteSkippedReason: string | undefined;
  const promotionLockTarget = await resolveMemoryPromotionLockTarget(workspaceDir);
  await withFileLock(promotionLockTarget, MEMORY_WRITE_LOCK_OPTIONS, async () => {
    await withMemoryWorkspaceLock(workspaceDir, async () => {
      const latestStore = await readStore(workspaceDir, nowIso);
      let retainedPreimageKeys: Set<string> | undefined;
      const authoritativeSelected: PromotionCandidate[] = [];
      for (const candidate of rehydratedSelected) {
        const entry = latestStore.entries[candidate.key];
        if (!entry) {
          const wasDirectCandidate =
            !options.consolidation &&
            plannedStoreEntryFingerprints.get(candidate.key) ===
              recallStoreEntryFingerprint(undefined);
          const sourceUnchanged =
            plannedSourceFingerprints.get(candidate.key) ===
            (await promotionSourceFingerprint(workspaceDir, candidate));
          if (
            wasDirectCandidate &&
            sourceUnchanged &&
            !isContaminatedDreamingSnippet(candidate.snippet)
          ) {
            authoritativeSelected.push(candidate);
          }
          continue;
        }
        if (entry.promotedAt) {
          continue;
        }
        const storeChanged =
          plannedStoreEntryFingerprints.get(candidate.key) !== recallStoreEntryFingerprint(entry);
        const sourceChanged =
          plannedSourceFingerprints.get(candidate.key) !==
          (await promotionSourceFingerprint(workspaceDir, candidate));
        if (storeChanged || sourceChanged) {
          continue;
        }
        const currentCandidate = withAuthoritativeProvenance(candidate, entry.provenance);
        if (options.consolidation && !isConsolidationCandidateEligible(currentCandidate)) {
          continue;
        }
        if (!isContaminatedDreamingSnippet(currentCandidate.snippet)) {
          authoritativeSelected.push(currentCandidate);
        }
      }
      memoryWritePath = await resolveMemoryWritePath(memoryPath, workspaceDir);
      existingMemory = await readMemoryContent(memoryWritePath, workspaceDir);
      existingMarkers = new Set(extractPromotionKeys(existingMemory));
      alreadyWritten = authoritativeSelected.filter((candidate) =>
        existingMarkers.has(candidate.key),
      );
      toAppend = authoritativeSelected.filter((candidate) => !existingMarkers.has(candidate.key));
      const successfulCandidates = new Map(
        alreadyWritten.map((candidate) => [candidate.key, candidate]),
      );
      const plannedKeys = new Set(
        consolidationPlan?.operations.map((operation) => operation.candidateKey) ?? [],
      );
      const planIsCurrent =
        consolidationPlan !== null &&
        plannedKeys.size === toAppend.length &&
        toAppend.every(
          (candidate) =>
            plannedKeys.has(candidate.key) &&
            plannedCandidateFingerprints.get(candidate.key) ===
              consolidationCandidateFingerprint(candidate),
        );
      if (planIsCurrent && consolidationPlan) {
        if (hashMemoryContent(existingMemory) !== consolidationBaseMemoryHash) {
          rewriteSkippedReason = "MEMORY.md changed while consolidation was running";
        } else {
          consolidationResult = applyMemoryConsolidationPlan({
            existingMemory,
            plan: consolidationPlan,
            nowMs,
            ...(options.timezone ? { timezone: options.timezone } : {}),
            memoryFileMaxChars: budgetChars,
            maxPriorEntryLossFraction,
          });
        }
      }
      if (consolidationResult) {
        try {
          retainedPreimageKeys = await storeMemoryPreimage({
            workspaceDir,
            content: existingMemory,
            nowMs,
            agentIds: originAgentIds,
            retainedEntryKeys: new Set([
              ...extractPromotionKeys(existingMemory),
              ...Object.keys(latestStore.entries),
            ]),
          });
        } catch (error) {
          options.consolidation?.logger.warn(
            `memory-core: consolidation preimage failed (${String(error)}); using append-only fallback.`,
          );
          consolidationResult = null;
        }
      }
      if (consolidationResult && consolidationPlan) {
        // Reserve lineage before publication; release new rows only when the
        // file owner rules out a replacement or reconciles an unchanged target.
        const rollbackOrigins = reserveMemoryEntryOrigins({
          agentIds: originAgentIds,
          previousMemory: existingMemory,
          operations: consolidationPlan.operations,
        });
        try {
          await commitMemoryContent({
            workspaceDir,
            filePath: memoryWritePath,
            tempPrefix: `${path.basename(memoryPath)}.promotion`,
            expectedHash: consolidationBaseMemoryHash,
            content: consolidationResult.content,
          });
          committedMemoryContent = consolidationResult.content;
          for (const candidate of toAppend) {
            successfulCandidates.set(candidate.key, candidate);
          }
          appendedCandidates = toAppend.length;
        } catch (error) {
          if (error instanceof MemoryAtomicPublicationError) {
            throw error;
          }
          rollbackOrigins();
          if (
            !(error instanceof MemoryWriteConflictError) &&
            !isAtomicReplacePermissionError(error)
          ) {
            throw error;
          }
          rewriteSkippedReason =
            error instanceof MemoryWriteConflictError
              ? "MEMORY.md changed immediately before the consolidation rename"
              : "the MEMORY.md directory blocked atomic replacement";
          consolidationResult = null;
          existingMemory = await readMemoryContent(memoryWritePath, workspaceDir);
          existingMarkers = new Set(extractPromotionKeys(existingMemory));
          alreadyWritten = authoritativeSelected.filter((candidate) =>
            existingMarkers.has(candidate.key),
          );
          toAppend = authoritativeSelected.filter(
            (candidate) => !existingMarkers.has(candidate.key),
          );
          successfulCandidates.clear();
          for (const candidate of alreadyWritten) {
            successfulCandidates.set(candidate.key, candidate);
          }
        }
      }
      if (!consolidationResult) {
        if (consolidationPlan) {
          options.consolidation?.logger.warn(
            "memory-core: promotion state or MEMORY.md changed during consolidation; using append-only fallback.",
          );
        }
        if (toAppend.length > 0) {
          // Model absence or rejected output preserves the shipped append-only
          // promotion contract, so a deep sweep never loses eligible memories.
          const appendPlan = buildBudgetedMemoryAppend({
            existingMemory,
            newSection: buildPromotionSection(
              toAppend,
              nowMs,
              options.timezone,
              options.maxPromotedSnippetTokens,
            ),
            budgetChars,
            maxPriorEntryLossFraction,
          });
          const { content, droppedDates } = appendPlan;
          if (budgetChars > 0 && content.length > budgetChars) {
            const reason = `MEMORY.md budget exceeded (${content.length} > ${budgetChars} chars)`;
            for (const candidate of toAppend) {
              reject(candidate.key, "memory budget", reason);
            }
            options.consolidation?.logger.info(
              `memory-core: deferred ${toAppend.length} promotion candidate(s) because ${reason}.`,
            );
          } else {
            // Append fallback keeps the historical read-modify-replace contract. Policy accepts
            // its external-editor race because OpenClaw writers remain serialized by this sweep lock.
            await commitMemoryContent({
              workspaceDir,
              filePath: memoryWritePath,
              tempPrefix: `${path.basename(memoryPath)}.promotion`,
              expectedHash: hashMemoryContent(existingMemory),
              expectedContent: existingMemory,
              allowInPlaceFallback: true,
              content,
            });
            committedMemoryContent = content;
            for (const candidate of toAppend) {
              successfulCandidates.set(candidate.key, candidate);
            }
            compactedDates = droppedDates;
            appendedCandidates = toAppend.length;
          }
        }
      }
      if (rewriteSkippedReason) {
        options.consolidation?.logger.warn(
          `memory-core: ${rewriteSkippedReason}; using append-only fallback.`,
        );
      }
      for (const candidate of successfulCandidates.values()) {
        const entry = latestStore.entries[candidate.key];
        if (!entry) {
          continue;
        }
        entry.startLine = candidate.startLine;
        entry.endLine = candidate.endLine;
        entry.snippet = candidate.snippet;
        entry.promotedAt = nowIso;
      }
      const latestUpdatedAtMs = Date.parse(latestStore.updatedAt);
      latestStore.updatedAt = resolveMemoryCoreTimestamp(
        Math.max(nowMs, Number.isFinite(latestUpdatedAtMs) ? latestUpdatedAtMs : 0),
      );
      await writeStore(workspaceDir, latestStore);
      if (options.agentId && committedMemoryContent) {
        retainedPreimageKeys ??= new Set(
          (await readMemoryPreimages(workspaceDir)).flatMap(({ value }) =>
            extractPromotionKeys(value.content),
          ),
        );
        await pruneMemoryEntryOrigins({
          workspaceDir,
          agentIds: originAgentIds,
          entryKeys: extractPromotionKeys(existingMemory),
          retainedEntryKeys: new Set([
            ...extractPromotionKeys(committedMemoryContent),
            ...Object.keys(latestStore.entries),
            ...retainedPreimageKeys,
          ]),
        });
      }
      committedCandidates = [...successfulCandidates.values()];
      // Publish quotes before releasing the deletion boundary; otherwise a
      // completed forget can be followed by a stale consolidation highlight.
      if (consolidationResult) {
        await appendConsolidationSummary({
          workspaceDir,
          result: consolidationResult,
          nowMs,
        }).catch((error: unknown) => {
          options.consolidation?.logger.warn(
            `memory-core: MEMORY.md was consolidated but DREAMS.md summary failed: ${String(error)}`,
          );
        });
      }
    });
  });
  if (!consolidationResult && rewriteSkippedReason) {
    await appendConsolidationSkippedSummary({
      workspaceDir,
      nowMs,
      reason: rewriteSkippedReason,
    }).catch((error: unknown) => {
      options.consolidation?.logger.warn(
        `memory-core: consolidation skip summary failed: ${String(error)}`,
      );
    });
  }

  await appendMemoryHostEvent(workspaceDir, {
    type: "memory.promotion.applied",
    timestamp: nowIso,
    memoryPath,
    applied: committedCandidates.length,
    candidates: committedCandidates.map((candidate) => ({
      key: candidate.key,
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      score: candidate.score,
      recallCount: candidate.recallCount,
    })),
  });

  return {
    memoryPath,
    applied: committedCandidates.length,
    appended: appendedCandidates,
    reconciledExisting: alreadyWritten.length,
    appliedCandidates: committedCandidates,
    rejectedCandidates: currentCandidates
      .filter((candidate) => !committedCandidates.some((applied) => applied.key === candidate.key))
      .map(describeRejection),
    compactedSections: compactedDates.length,
    compactedDates,
  };
}
