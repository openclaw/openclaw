import {
  defaultRuntime,
  formatDocsLink,
  formatErrorMessage,
  shortenHomePath,
  theme,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import {
  resolveMemoryDreamingWorkspace,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  formatAuditCounts,
  resolveMemoryPluginConfig,
  withMemoryCommand,
} from "./cli-runtime-common.js";
import type { MemoryPromoteCommandOptions, MemoryPromoteExplainOptions } from "./cli.types.js";
import { resolveMemoryPromotionFileMaxChars } from "./memory-budget.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import {
  countPromotionExclusions,
  countPromotionRejections,
  describePromotionExclusion,
  formatLabelCounts,
  type PromotionExclusionCount,
} from "./short-term-promotion-exclusions.js";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  isDailyFileQuarantined,
  rankShortTermPromotionCandidates,
  readDailyFileProvenanceByPath,
  resolveShortTermRecallLockPath,
  resolveShortTermRecallStorePath,
  type RankShortTermPromotionResult,
} from "./short-term-promotion.js";

const { accent, heading, muted, success, warn } = theme;

function matchesPromotionSelector(
  candidate: {
    key: string;
    path: string;
    snippet: string;
  },
  selector: string,
): boolean {
  const trimmed = selector.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return (
    candidate.key.toLowerCase().includes(trimmed) ||
    candidate.path.toLowerCase().includes(trimmed) ||
    candidate.snippet.toLowerCase().includes(trimmed)
  );
}
const MEMORY_ARCHITECTURE_DOCS = formatDocsLink(
  "/concepts/memory-architecture",
  "docs.openclaw.ai/concepts/memory-architecture",
);

function formatPromotionExclusionLines(params: {
  agentId: string;
  ranking: RankShortTermPromotionResult;
  exclusionCounts: PromotionExclusionCount[];
  minUniqueQueries: number;
}): string[] {
  const { ranking, exclusionCounts } = params;
  if (ranking.considered === 0) {
    return [muted("Recall store is empty.")];
  }
  const excluded = ranking.exclusions.length;
  if (excluded === 0) {
    return [];
  }
  const lines = [
    muted(
      `Excluded ${excluded} of ${ranking.considered}: ${formatLabelCounts(exclusionCounts.map(({ reason, count }) => [reason, count]))}`,
    ),
  ];
  // Explain only when exclusions dominate; a healthy store just gets the counts.
  if (excluded > ranking.candidates.length) {
    const top = exclusionCounts.toSorted((left, right) => right.count - left.count).slice(0, 2);
    for (const { reason, count } of top) {
      lines.push(
        `${warn(`${reason} (${count}):`)} ${describePromotionExclusion(reason, { minUniqueQueries: params.minUniqueQueries })}`,
      );
    }
    const sampleKey = top[0]?.sampleKeys[0];
    if (sampleKey) {
      // Without --agent, promote-explain resolves the default agent's workspace.
      lines.push(
        muted(`see: openclaw memory promote-explain ${sampleKey} --agent ${params.agentId}`),
      );
    }
    lines.push(`${muted("Docs:")} ${MEMORY_ARCHITECTURE_DOCS}`);
  }
  return lines;
}

async function runMemoryPromotion(
  opts: MemoryPromoteCommandOptions,
  hostOptions: MemoryCoreRuntimeHost | undefined,
  selector?: string,
) {
  const explain = selector !== undefined;
  const command = explain ? "promote-explain" : "promote";
  await withMemoryCommand({
    commandName: `memory ${command}`,
    options: opts,
    purpose: "status",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const dreaming = resolveMemoryDeepDreamingConfig({
        pluginConfig: resolveMemoryPluginConfig(cfg),
        cfg,
      });
      if (!workspaceDir) {
        throw new Error(`Memory ${command} requires a resolvable workspace directory.`);
      }
      let ranking: RankShortTermPromotionResult;
      try {
        const gatherAllForApply = !explain && Boolean(opts.apply);
        const unrestricted = explain || gatherAllForApply;
        ranking = await rankShortTermPromotionCandidates({
          workspaceDir,
          limit: unrestricted ? undefined : opts.limit,
          minScore: unrestricted ? 0 : (opts.minScore ?? dreaming.minScore),
          minRecallCount: unrestricted ? 0 : (opts.minRecallCount ?? dreaming.minRecallCount),
          minUniqueQueries: unrestricted ? 0 : (opts.minUniqueQueries ?? dreaming.minUniqueQueries),
          recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
          maxAgeDays: gatherAllForApply ? undefined : dreaming.maxAgeDays,
          includePromoted: Boolean(opts.includePromoted),
        });
      } catch (err) {
        throw new Error(
          `${explain ? "Memory promote-explain" : "Memory promote ranking"} failed: ${formatErrorMessage(err)}`,
          {
            cause: err,
          },
        );
      }
      if (selector !== undefined) {
        const thresholds = {
          minScore: dreaming.minScore,
          minRecallCount: dreaming.minRecallCount,
          minUniqueQueries: dreaming.minUniqueQueries,
          maxAgeDays: dreaming.maxAgeDays ?? null,
        };
        // Keys can prefix one another, so an exact key (as printed by `promote`) wins over substrings.
        const key = selector.trim();
        const exactExcluded = ranking.exclusions.find((entry) => entry.key === key);
        const candidate = exactExcluded
          ? undefined
          : (ranking.candidates.find((entry) => entry.key === key) ??
            ranking.candidates.find((entry) => matchesPromotionSelector(entry, selector)));
        if (!candidate) {
          const excluded =
            exactExcluded ??
            ranking.exclusions.find((entry) => matchesPromotionSelector(entry, selector));
          if (!excluded) {
            throw new Error(`No promotion candidate matched "${selector}".`);
          }
          if (opts.json) {
            defaultRuntime.writeJson({ workspaceDir, thresholds, excluded });
            return;
          }
          defaultRuntime.log(
            [
              `${heading("Promotion Explain")} ${muted("(" + agentId + ")")}`,
              accent(excluded.key),
              muted(shortenHomePath(excluded.path)),
              excluded.snippet,
              warn(
                `Excluded by ${excluded.reason}${excluded.detail ? ` (${excluded.detail})` : ""}: ${describePromotionExclusion(excluded.reason, thresholds)}`,
              ),
            ].join("\n"),
          );
          return;
        }
        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            thresholds,
            candidate,
            passes: {
              score: candidate.score >= thresholds.minScore,
              // Engine gate is aggregate signalCount vs minRecallCount (config name unchanged).
              recallCount: candidate.signalCount >= thresholds.minRecallCount,
              uniqueQueries: candidate.uniqueQueries >= thresholds.minUniqueQueries,
              maxAge:
                thresholds.maxAgeDays === null ? true : candidate.ageDays <= thresholds.maxAgeDays,
            },
          });
          return;
        }
        const lines = [
          `${heading("Promotion Explain")} ${muted("(" + agentId + ")")}`,
          accent(candidate.key),
          muted(
            `${shortenHomePath(candidate.path)}:${String(candidate.startLine)}-${String(candidate.endLine)}`,
          ),
          candidate.snippet,
          muted(
            `score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} uniqueQueries=${candidate.uniqueQueries} ageDays=${candidate.ageDays.toFixed(1)}`,
          ),
          muted(
            `components: frequency=${candidate.components.frequency.toFixed(2)} relevance=${candidate.components.relevance.toFixed(2)} diversity=${candidate.components.diversity.toFixed(2)} recency=${candidate.components.recency.toFixed(2)} consolidation=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`,
          ),
          muted(
            `thresholds: minScore=${thresholds.minScore} minRecallCount=${thresholds.minRecallCount} minUniqueQueries=${thresholds.minUniqueQueries} maxAgeDays=${thresholds.maxAgeDays ?? "none"}`,
          ),
        ];
        if (candidate.conceptTags.length > 0) {
          lines.push(muted(`concepts=${candidate.conceptTags.join(", ")}`));
        }
        defaultRuntime.log(lines.join("\n"));
        return;
      }
      const { candidates } = ranking;
      let applyResult: Awaited<ReturnType<typeof applyShortTermPromotions>> | undefined;
      if (opts.apply) {
        try {
          const workspaceAgentIds = resolveMemoryDreamingWorkspace(cfg, workspaceDir)?.agentIds ?? [
            agentId,
          ];
          applyResult = await applyShortTermPromotions({
            agentId,
            workspaceAgentIds,
            workspaceDir,
            candidates,
            limit: opts.limit,
            minScore: opts.minScore ?? dreaming.minScore,
            minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
            minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
            maxAgeDays: dreaming.maxAgeDays,
            maxPromotedSnippetTokens: dreaming.maxPromotedSnippetTokens,
            maxPriorEntryLossFraction: dreaming.maxPriorEntryLossFraction,
            memoryFileMaxChars: resolveMemoryPromotionFileMaxChars({
              cfg,
              agentIds: workspaceAgentIds,
            }),
            timezone: dreaming.timezone,
          });
        } catch (err) {
          throw new Error(`Memory promote apply failed: ${formatErrorMessage(err)}`, {
            cause: err,
          });
        }
      }
      const outputLimit = resolveNonNegativeIntegerOption(opts.limit, candidates.length);
      const rejectedCandidates = applyResult
        ? applyResult.rejectedCandidates.slice(
            0,
            Math.max(0, outputLimit - applyResult.appliedCandidates.length),
          )
        : [];
      const outputCandidateKeys = applyResult
        ? new Set([
            ...applyResult.appliedCandidates.map((candidate) => candidate.key),
            ...rejectedCandidates.map((rejection) => rejection.candidate.key),
          ])
        : undefined;
      const outputCandidates = outputCandidateKeys
        ? candidates.filter((candidate) => outputCandidateKeys.has(candidate.key))
        : candidates;
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      const thresholds = {
        minScore: opts.minScore ?? dreaming.minScore,
        minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
        minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
        maxAgeDays: dreaming.maxAgeDays ?? null,
        overridden: [
          ...(opts.minScore === undefined ? [] : ["--min-score"]),
          ...(opts.minRecallCount === undefined ? [] : ["--min-recall-count"]),
          ...(opts.minUniqueQueries === undefined ? [] : ["--min-unique-queries"]),
        ],
      };
      const exclusionCounts = countPromotionExclusions(ranking.exclusions);
      // Apply rejects these itself; preview only flags them so nothing looks promotable that isn't.
      const dailyProvenanceByPath = applyResult
        ? undefined
        : await readDailyFileProvenanceByPath(workspaceDir);
      const quarantinedKeys = new Set(
        dailyProvenanceByPath
          ? outputCandidates
              .filter((candidate) => isDailyFileQuarantined(candidate, dailyProvenanceByPath))
              .map((candidate) => candidate.key)
          : [],
      );
      if (opts.json) {
        defaultRuntime.writeJson({
          agentId,
          workspaceDir,
          storePath,
          lockPath,
          audit,
          thresholds,
          exclusions: {
            considered: ranking.considered,
            excluded: ranking.exclusions.length,
            byReason: exclusionCounts,
            quarantinedAtApply: {
              count: quarantinedKeys.size,
              sampleKeys: [...quarantinedKeys].slice(0, 3),
            },
          },
          candidates: outputCandidates,
          apply: applyResult
            ? {
                applied: applyResult.applied,
                appended: applyResult.appended,
                reconciledExisting: applyResult.reconciledExisting,
                memoryPath: applyResult.memoryPath,
                appliedCandidates: applyResult.appliedCandidates,
                rejectedCandidates,
                rejectionsByReason: countPromotionRejections(applyResult.rejectedCandidates),
              }
            : undefined,
        });
        return;
      }
      const identityLine = `${muted("Agent:")} ${agentId} · ${muted("Workspace:")} ${shortenHomePath(workspaceDir)} · ${muted("Recall store:")} ${storePath}`;
      const exclusionLines = formatPromotionExclusionLines({
        agentId,
        ranking,
        exclusionCounts,
        minUniqueQueries: thresholds.minUniqueQueries,
      });
      if (candidates.length === 0) {
        defaultRuntime.log(
          [
            "No short-term recall candidates.",
            identityLine,
            ...exclusionLines,
            ...audit.issues.map((issue) => issue.message),
          ].join("\n"),
        );
        return;
      }
      const lines: string[] = [];
      lines.push(`${heading("Short-Term Promotion Candidates")} ${muted(`(${agentId})`)}`);
      lines.push(identityLine);
      lines.push(muted(`Store health: ${formatAuditCounts(audit)}`));
      lines.push(...exclusionLines);
      if (quarantinedKeys.size > 0) {
        lines.push(
          warn(
            `${quarantinedKeys.size} candidate(s) come from untrusted daily files; --apply will reject them (origin).`,
          ),
        );
      }
      lines.push("");
      for (const candidate of outputCandidates) {
        lines.push(
          `${success(candidate.score.toFixed(3))} ${accent(`${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}`)}`,
        );
        lines.push(
          muted(
            `signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} queries=${candidate.uniqueQueries} age=${candidate.ageDays.toFixed(1)}d consolidate=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`,
          ),
        );
        if (candidate.conceptTags.length > 0) {
          lines.push(muted(`concepts=${candidate.conceptTags.join(", ")}`));
        }
        if (candidate.snippet) {
          lines.push(muted(candidate.snippet));
        }
        if (quarantinedKeys.has(candidate.key)) {
          lines.push(warn("quarantined at apply: its daily file is untrusted"));
        }
        lines.push("");
      }
      if (audit.issues.length > 0) {
        lines.push(warn("Audit issues:"));
        for (const issue of audit.issues) {
          lines.push((issue.severity === "error" ? warn : muted)(issue.message));
        }
        lines.push("");
      }
      if (applyResult) {
        const rejectionCounts = countPromotionRejections(applyResult.rejectedCandidates);
        if (rejectionCounts.length > 0) {
          lines.push(
            muted(
              `Apply rejected ${applyResult.rejectedCandidates.length}: ${formatLabelCounts(rejectionCounts.map(({ category, count }) => [category, count]))}`,
            ),
          );
        }
        for (const rejection of rejectedCandidates) {
          const candidate = rejection.candidate;
          const source = `${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}`;
          lines.push(warn(`Skipped ${source}: ${rejection.reason}.`));
        }
        if (applyResult.applied > 0) {
          lines.push(
            success(
              `Processed ${applyResult.applied} candidate(s) for ${shortenHomePath(applyResult.memoryPath)}.`,
            ),
          );
          lines.push(
            muted(
              `appended=${applyResult.appended} reconciledExisting=${applyResult.reconciledExisting}`,
            ),
          );
        } else if (rejectedCandidates.length === 0) {
          lines.push(warn("No candidates met apply criteria."));
        }
      }
      defaultRuntime.log(lines.join("\n").trim());
    },
  });
}
export async function runMemoryPromote(
  opts: MemoryPromoteCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await runMemoryPromotion(opts, hostOptions);
}

export async function runMemoryPromoteExplain(
  selector: string,
  opts: MemoryPromoteExplainOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await runMemoryPromotion(opts, hostOptions, selector);
}
