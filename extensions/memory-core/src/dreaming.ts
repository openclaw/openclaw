import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { resolveMemoryDreamingPluginConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT as DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { type CronServiceLike, reconcileShortTermDreamingCronJob } from "./dreaming-cron.js";
import { appendFailedDreamingEvent } from "./dreaming-events.js";
import type { DreamNarrativeRequest, NarrativePhaseData } from "./dreaming-narrative.js";
import {
  formatErrorMessage,
  formatRecallRepairDetails,
  includesSystemEventToken,
} from "./dreaming-shared.js";
import { resolveMemoryPromotionFileMaxChars } from "./memory-budget.js";
import type { PromotionRejectionCategory } from "./short-term-promotion-types.js";

const RUNTIME_CRON_RECONCILE_INTERVAL_MS = 60_000;
// Installed generations coordinate the same durable declaration without sharing managers.
const cronMaintenance = resolveGlobalSingleton(
  Symbol.for("openclaw.memoryCore.dreamingCron"),
  () => ({
    queue: new KeyedAsyncQueue(),
    owners: new Map<string, Set<() => void>>(),
  }),
);

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type ShortTermPromotionDreamingConfig = ReturnType<typeof resolveMemoryDeepDreamingConfig>;

function formatRepairSummary(repair: {
  rewroteStore: boolean;
  removedInvalidEntries: number;
  removedDanglingEntries?: number;
  removedOverflowEntries?: number;
  removedStaleLock: boolean;
}): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    const details = formatRecallRepairDetails(repair);
    actions.push(`rewrote recall store${details ? ` (${details})` : ""}`);
  }
  if (repair.removedStaleLock) {
    actions.push("removed stale promotion lock");
  }
  return actions.join(", ");
}

async function runShortTermDreamingPromotion(params: {
  runInBackground?: DreamNarrativeRequest["runInBackground"];
  /** Agent whose heartbeat/cron turn triggered the sweep. */
  agentId?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
  subagent?: OpenClawPluginApi["runtime"]["subagent"];
  narrativeTimeoutMs: number;
  consolidationTimeoutMs?: number;
}): Promise<{ handled: true; reason: string } | undefined> {
  const recencyHalfLifeDays = params.config.recencyHalfLifeDays;
  const fallbackWorkspaceDir = normalizeOptionalString(params.workspaceDir);
  // Each completion uses its workspace owner's model and credentials. The triggering
  // agent owns whatever the roster cannot attribute.
  const triggerAgentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const workspaces = params.cfg
    ? resolveMemoryDreamingWorkspaces(params.cfg, {
        primaryWorkspaceDir: fallbackWorkspaceDir,
        ...(triggerAgentId ? { primaryAgentId: triggerAgentId } : {}),
      }).map(({ workspaceDir, agentIds }) => {
        // The host deduplicates workspaces. Prefer their triggering agent,
        // otherwise select a stable owner among agents sharing the workspace.
        const agentId =
          triggerAgentId && agentIds.includes(triggerAgentId)
            ? triggerAgentId
            : (agentIds.toSorted()[0] ?? triggerAgentId);
        return agentId ? { agentId, agentIds, workspaceDir } : { agentIds, workspaceDir };
      })
    : [];
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    workspaces.push({
      ...(triggerAgentId ? { agentId: triggerAgentId } : {}),
      agentIds: [triggerAgentId],
      workspaceDir: fallbackWorkspaceDir,
    });
  }
  if (workspaces.length === 0) {
    params.logger.warn(
      "memory-core: dreaming promotion skipped because no memory workspace is available.",
    );
    return { handled: true, reason: "memory-core: short-term dreaming missing workspace" };
  }
  if (params.config.limit === 0) {
    params.logger.info("memory-core: dreaming promotion skipped because limit=0.");
    return { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };
  }

  if (params.config.verboseLogging) {
    params.logger.info(
      `memory-core: dreaming verbose enabled (cron=${params.config.cron}, limit=${params.config.limit}, minScore=${params.config.minScore.toFixed(3)}, minRecallCount=${params.config.minRecallCount}, minUniqueQueries=${params.config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${params.config.maxAgeDays ?? "none"}, workspaces=${workspaces.length}).`,
    );
  }

  let totalCandidates = 0;
  let totalApplied = 0;
  let failedWorkspaces = 0;
  let degradedNarratives = 0;
  let pendingNarratives = 0;
  const pluginConfig = params.cfg ? resolveMemoryDreamingPluginConfig(params.cfg) : undefined;
  const [
    { writeDeepDreamingReport },
    { appendFallbackNarrativeEntry, runDreamNarrative },
    { runDreamingSweepPhases },
    {
      applyShortTermPromotions,
      repairShortTermPromotionArtifacts,
      rankShortTermPromotionCandidates,
    },
  ] = await Promise.all([
    import("./dreaming-markdown.js"),
    import("./dreaming-narrative.js"),
    import("./dreaming-phases.js"),
    import("./short-term-promotion.js"),
  ]);
  for (const { agentId, agentIds, workspaceDir } of workspaces) {
    const workspaceFileMode =
      (params.cfg && agentId
        ? resolveAgentConfig(params.cfg, agentId)?.workspaceFileMode
        : undefined) ?? params.cfg?.agents?.defaults?.workspaceFileMode;
    const sweepNowMs = Date.now();
    let phaseResult: Awaited<ReturnType<typeof runDreamingSweepPhases>>;
    try {
      phaseResult = await runDreamingSweepPhases({
        agentId,
        workspaceDir,
        workspaceFileMode,
        pluginConfig,
        cfg: params.cfg,
        logger: params.logger,
        nowMs: sweepNowMs,
      });
    } catch (err) {
      failedWorkspaces += 1;
      params.logger.error(
        `memory-core: dreaming sweep failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
      continue;
    }

    const { narratives, failed } = phaseResult;
    if (failed) {
      failedWorkspaces += 1;
    } else {
      try {
        const reportLines: string[] = [];
        const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
        if (repair.changed) {
          params.logger.info(
            `memory-core: normalized recall artifacts before dreaming (${formatRepairSummary(repair)}) [workspace=${workspaceDir}].`,
          );
          reportLines.push(`- Repaired recall artifacts: ${formatRepairSummary(repair)}.`);
        }
        const candidates = await rankShortTermPromotionCandidates({
          workspaceDir,
          limit: params.config.limit,
          minScore: params.config.minScore,
          minRecallCount: params.config.minRecallCount,
          minUniqueQueries: params.config.minUniqueQueries,
          recencyHalfLifeDays,
          maxAgeDays: params.config.maxAgeDays,
          nowMs: sweepNowMs,
        });
        totalCandidates += candidates.length;
        reportLines.push(`- Ranked ${candidates.length} candidate(s) for durable promotion.`);
        if (params.config.verboseLogging) {
          const candidateSummary =
            candidates.length > 0
              ? candidates
                  .map(
                    (candidate) =>
                      `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} queries=${candidate.uniqueQueries} components={freq=${candidate.components.frequency.toFixed(3)},rel=${candidate.components.relevance.toFixed(3)},div=${candidate.components.diversity.toFixed(3)},rec=${candidate.components.recency.toFixed(3)},cons=${candidate.components.consolidation.toFixed(3)},concept=${candidate.components.conceptual.toFixed(3)}}`,
                  )
                  .join(" | ")
              : "none";
          params.logger.info(
            `memory-core: dreaming candidate details [workspace=${workspaceDir}] ${candidateSummary}`,
          );
        }
        const applied = await applyShortTermPromotions({
          agentId,
          workspaceAgentIds: agentIds,
          workspaceDir,
          workspaceFileMode,
          candidates,
          limit: params.config.limit,
          minScore: params.config.minScore,
          minRecallCount: params.config.minRecallCount,
          minUniqueQueries: params.config.minUniqueQueries,
          maxAgeDays: params.config.maxAgeDays,
          maxPromotedSnippetTokens: params.config.maxPromotedSnippetTokens,
          maxPriorEntryLossFraction: params.config.maxPriorEntryLossFraction,
          memoryFileMaxChars: resolveMemoryPromotionFileMaxChars({
            cfg: params.cfg,
            agentIds,
          }),
          consolidation: {
            ...(params.subagent ? { subagent: params.subagent } : {}),
            ...(params.config.execution?.model ? { model: params.config.execution.model } : {}),
            ...(params.consolidationTimeoutMs !== undefined
              ? { timeoutMs: params.consolidationTimeoutMs }
              : {}),
            logger: params.logger,
          },
          timezone: params.config.timezone,
          nowMs: sweepNowMs,
        });
        totalApplied += applied.applied;
        reportLines.push(`- Promoted ${applied.applied} candidate(s) into MEMORY.md.`);
        if (applied.rejectedCandidates.length > 0) {
          const rejectionCounts = new Map<PromotionRejectionCategory, number>();
          for (const { category } of applied.rejectedCandidates) {
            rejectionCounts.set(category, (rejectionCounts.get(category) ?? 0) + 1);
          }
          const summary = [...rejectionCounts]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([category, count]) => `${category}: ${count}`)
            .join(", ");
          reportLines.push(
            `- Not promoted: ${applied.rejectedCandidates.length} candidate(s) (${summary}).`,
          );
        }
        if (params.config.verboseLogging) {
          const appliedSummary =
            applied.appliedCandidates.length > 0
              ? applied.appliedCandidates
                  .map(
                    (candidate) =>
                      `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount}`,
                  )
                  .join(" | ")
              : "none";
          params.logger.info(
            `memory-core: dreaming applied details [workspace=${workspaceDir}] ${appliedSummary}`,
          );
        }
        if (applied.applied > 0) {
          const promotions = applied.appliedCandidates
            .map((candidate) => candidate.snippet)
            .filter(Boolean);
          const data: NarrativePhaseData = {
            phase: "deep",
            snippets: promotions,
            promotions,
            sourceEntryKeys: [...new Set(applied.appliedCandidates.map((c) => c.key))],
          };
          narratives.push({
            data,
            timezone: params.config.timezone,
            model: params.config.execution?.model,
          });
        }
        const hasReportableRejections = applied.rejectedCandidates.some(
          ({ category }) => category !== "memory budget",
        );
        const deepHasContent = repair.changed || applied.applied > 0 || hasReportableRejections;
        await writeDeepDreamingReport({
          workspaceDir,
          workspaceFileMode,
          bodyLines: reportLines,
          hasContent: deepHasContent,
          nowMs: sweepNowMs,
          timezone: params.config.timezone,
          storage: params.config.storage ?? { mode: "separate", separateReports: false },
        });
      } catch (err) {
        failedWorkspaces += 1;
        const error = formatErrorMessage(err);
        params.logger.error(
          `memory-core: dreaming promotion failed for workspace ${workspaceDir}: ${error}`,
        );
        await appendFailedDreamingEvent({
          workspaceDir,
          phase: "deep",
          error,
          storageMode: params.config.storage?.mode ?? "separate",
          nowMs: sweepNowMs,
          logger: params.logger,
        });
      }
    }
    // The sweep owns diary publication, not the individual phases. Preserve prepared
    // Light/REM material even when promotion/reporting failed, and publish only once.
    const firstNarrative = narratives[0];
    const lastNarrative = narratives.at(-1);
    if (!firstNarrative || !lastNarrative) {
      continue;
    }
    const data: NarrativePhaseData = {
      ...firstNarrative.data,
      phase: lastNarrative.data.phase,
      snippets: uniqueStrings(narratives.flatMap(({ data: phaseData }) => phaseData.snippets)),
      themes: uniqueStrings(narratives.flatMap(({ data: phaseData }) => phaseData.themes ?? [])),
      promotions: uniqueStrings(
        narratives.flatMap(({ data: phaseData }) => phaseData.promotions ?? []),
      ),
      sourceEntryKeys: uniqueStrings(
        narratives.flatMap(({ data: phaseData }) => phaseData.sourceEntryKeys ?? []),
      ),
    };
    if (!params.subagent) {
      await appendFallbackNarrativeEntry({
        workspaceDir,
        workspaceFileMode,
        data,
        nowMs: sweepNowMs,
        timezone: lastNarrative.timezone,
        logger: params.logger,
        reason: "subagent runtime is unavailable",
      });
    } else {
      const narrativeOutcome = await runDreamNarrative({
        agentId,
        timeoutMs: params.narrativeTimeoutMs,
        subagent: params.subagent,
        workspaceDir,
        workspaceFileMode,
        data,
        nowMs: sweepNowMs,
        timezone: lastNarrative.timezone,
        model: lastNarrative.model,
        logger: params.logger,
        runInBackground: params.runInBackground,
      });
      if (narrativeOutcome.status === "degraded") {
        degradedNarratives += 1;
      } else if (narrativeOutcome.status === "pending") {
        pendingNarratives += 1;
      }
    }
  }
  // A summary that reads identically whether the sweep worked or failed everywhere is how
  // a broken pipeline stays unnoticed; escalate when no workspace produced anything.
  const summary = `memory-core: dreaming promotion complete (workspaces=${workspaces.length}, candidates=${totalCandidates}, applied=${totalApplied}, failed=${failedWorkspaces}, degraded=${degradedNarratives}, narrativesPending=${pendingNarratives}).`;
  if (failedWorkspaces === workspaces.length || degradedNarratives > 0) {
    params.logger.warn(summary);
  } else {
    params.logger.info(summary);
  }

  return {
    handled: true,
    reason:
      degradedNarratives > 0
        ? "memory-core: short-term dreaming degraded"
        : "memory-core: short-term dreaming processed",
  };
}

export function registerShortTermPromotionDreaming(api: OpenClawPluginApi): void {
  let resolveServiceCron: (() => CronServiceLike | null) | null = null;
  let unavailableCronWarningEmitted = false;
  let missingOwnerWarningEmitted = false;
  let startupDreamingCleanup: ReturnType<PluginServiceSchedulerV1["schedule"]> | undefined;
  const dreamingTasks = new Set<Promise<unknown>>();
  let scheduler: PluginServiceSchedulerV1 | undefined;
  let stateDir = "";
  let disposed = true;
  let serviceStartedAtMs: number | undefined;

  const resolveCurrentConfig = (): OpenClawConfig =>
    (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;

  const disposeDreaming = (): void => {
    disposed = true;
    scheduler?.beginClose();
    startupDreamingCleanup = undefined;
    resolveServiceCron = null;
  };

  const reconcileManagedDreamingCron = async (params: {
    reason: "startup" | "runtime";
    startupConfig?: OpenClawConfig;
  }): Promise<void> =>
    cronMaintenance.queue.enqueue(stateDir, async () => {
      if (
        disposed ||
        [...(cronMaintenance.owners.get(stateDir) ?? [])].at(-1) !== requestCronReconcile
      ) {
        return;
      }
      const startupCfg =
        params.reason === "startup" ? (params.startupConfig ?? api.config) : resolveCurrentConfig();
      const pluginConfig =
        params.reason === "startup"
          ? (resolveMemoryDreamingPluginConfig(startupCfg) ??
            resolveMemoryDreamingPluginConfig(api.config) ??
            api.pluginConfig)
          : resolveMemoryDreamingPluginConfig(startupCfg);
      const config = resolveMemoryDeepDreamingConfig({
        pluginConfig,
        cfg: startupCfg,
      });
      const cron = resolveServiceCron?.() ?? null;
      // Pausing automatic scheduling preserves jobs; explicitly disabling dreaming
      // still reconciles their removal, and startup artifact cleanup stays independent.
      if (config.enabled && cron?.isEnabled && !(await cron.isEnabled())) {
        return;
      }
      if (!cron && config.enabled && !unavailableCronWarningEmitted) {
        // A non-Gateway host may attach its scheduler later; report persistent
        // unavailability from the regular reconciliation interval.
        if (params.reason === "startup") {
          api.logger.debug?.(
            "memory-core: cron service not yet available at service start; deferring to runtime reconciliation.",
          );
        } else {
          api.logger.warn(
            "memory-core: managed dreaming cron could not be reconciled (cron service unavailable).",
          );
          unavailableCronWarningEmitted = true;
        }
      }
      if (cron) {
        unavailableCronWarningEmitted = false;
      }
      const result = await reconcileShortTermDreamingCronJob({
        cron,
        config,
        logger: api.logger,
      });
      const missingOwner = result.status === "owner-required";
      if (missingOwner && !missingOwnerWarningEmitted) {
        api.logger.warn(
          "memory-core: managed dreaming cron job was not created because no ambient agent owner is configured. Set agents.defaults.systemAgent.agentId to an existing agent to enable automatic dreaming.",
        );
      }
      missingOwnerWarningEmitted = missingOwner;
    });

  const scheduleCronReconcile = (delayMs: number): void => {
    if (disposed || !scheduler || scheduler.signal.aborted) {
      return;
    }
    scheduler.schedule({
      id: "dreaming-cron-reconcile",
      delayMs,
      everyMs: RUNTIME_CRON_RECONCILE_INTERVAL_MS,
      async run() {
        try {
          await reconcileManagedDreamingCron({ reason: "runtime" });
        } catch (err) {
          api.logger.error(
            `memory-core: dreaming cron reconcile failed: ${formatErrorMessage(err)}`,
          );
        }
      },
    });
  };
  const requestCronReconcile = () => scheduleCronReconcile(0);

  const trackDreamingTask = async <T>(run: () => Promise<T>): Promise<T> => {
    const task = api.lifecycle.runInBackgroundContext
      ? api.lifecycle.runInBackgroundContext(run)
      : run();
    dreamingTasks.add(task);
    try {
      return await task;
    } finally {
      dreamingTasks.delete(task);
    }
  };

  const startDreamingSessionCleanup = async (
    config: OpenClawConfig,
    startupStartedAtMs: number,
  ): Promise<void> => {
    // Previous releases persisted narrative sessions. Reclaim those historical artifacts
    // at startup; new prompt-only completions create no sessions to scrub.
    const { DREAMING_ORPHAN_MIN_AGE_MS, scrubDreamingNarrativeArtifacts } =
      await import("./dreaming-session-cleanup.js");
    if (disposed) {
      return;
    }
    const scrubConfiguredAgents = async (
      currentConfig: OpenClawConfig,
      nowMs?: number,
    ): Promise<void> => {
      const agentIds = uniqueStrings(
        resolveMemoryDreamingWorkspaces(currentConfig).flatMap(
          ({ agentIds: workspaceAgentIds }) => workspaceAgentIds,
        ),
      );
      for (const agentId of agentIds) {
        if (disposed) {
          return;
        }
        try {
          await scrubDreamingNarrativeArtifacts({
            agentId,
            config: currentConfig,
            logger: api.logger,
            ...(nowMs === undefined ? {} : { nowMs }),
          });
        } catch (error) {
          api.logger.warn(
            `memory-core: dreaming startup cleanup failed for agent ${agentId}: ${formatErrorMessage(error)}`,
          );
        }
      }
    };

    // Cron reconciliation can itself stall; never classify sessions admitted after startup.
    await scrubConfiguredAgents(config, startupStartedAtMs);
    if (disposed || scheduler?.signal.aborted) {
      return;
    }
    // Interrupted runs are initially indistinguishable from live runs; revisit once their
    // persisted activity ages past the same guard used by normal narrative cleanup.
    startupDreamingCleanup = scheduler?.schedule({
      id: "dreaming-startup-cleanup",
      delayMs: DREAMING_ORPHAN_MIN_AGE_MS,
      async run() {
        startupDreamingCleanup = undefined;
        // Keep the cutoff before startup, including sessions admitted in the same millisecond.
        try {
          await scrubConfiguredAgents(
            resolveCurrentConfig(),
            startupStartedAtMs + DREAMING_ORPHAN_MIN_AGE_MS - 1,
          );
        } catch (error) {
          api.logger.warn(
            `memory-core: deferred dreaming startup cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      },
    });
  };

  api.registerService({
    id: "memory-core-dreaming",
    apiVersion: 2,
    async start(ctx) {
      if (!ctx.getCron) {
        return;
      }
      serviceStartedAtMs = Date.now();
      disposed = false;
      scheduler = ctx.scheduler.scope();
      stateDir = ctx.stateDir;
      const owners = cronMaintenance.owners.get(stateDir) ?? new Set<() => void>();
      owners.add(requestCronReconcile);
      cronMaintenance.owners.set(stateDir, owners);
      resolveServiceCron = () => ctx.getCron?.() ?? null;
      void trackDreamingTask(async () => {
        try {
          await reconcileManagedDreamingCron({
            reason: "startup",
            startupConfig: ctx.config,
          });
        } catch (err) {
          api.logger.error(
            `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
          );
        } finally {
          scheduleCronReconcile(RUNTIME_CRON_RECONCILE_INTERVAL_MS);
        }
      });
    },
    async stop() {
      const owners = cronMaintenance.owners.get(stateDir);
      const wasCurrent = owners && [...owners].at(-1) === requestCronReconcile;
      owners?.delete(requestCronReconcile);
      if (owners?.size === 0) {
        cronMaintenance.owners.delete(stateDir);
      }
      disposeDreaming();
      await Promise.allSettled(dreamingTasks);
      await scheduler?.stop();
      // Failed successor preparation returns maintenance to the still-live predecessor.
      if (wasCurrent) {
        [...(cronMaintenance.owners.get(stateDir) ?? [])].at(-1)?.();
      }
    },
  });

  api.on("gateway_start", (_event, ctx) => {
    const startupStartedAtMs = serviceStartedAtMs;
    if (disposed || startupStartedAtMs === undefined) {
      return;
    }
    startupDreamingCleanup?.cancel();
    startupDreamingCleanup = undefined;
    // Historical cleanup is maintenance, not activation. Keep it owned by the
    // instance and joined at service stop without consuming the start hook deadline.
    void trackDreamingTask(() =>
      startDreamingSessionCleanup(ctx.config ?? api.config, startupStartedAtMs),
    ).catch((error: unknown) => {
      api.logger.warn(`memory-core: dreaming startup cleanup failed: ${formatErrorMessage(error)}`);
    });
  });

  api.on(
    "before_agent_reply",
    async (event, ctx) => {
      try {
        if (ctx.trigger !== "heartbeat" && ctx.trigger !== "cron") {
          return undefined;
        }
        if (!includesSystemEventToken(event.cleanedBody, DREAMING_SYSTEM_EVENT_TEXT)) {
          return undefined;
        }
        const currentConfig = resolveCurrentConfig();
        const config = resolveMemoryDeepDreamingConfig({
          pluginConfig: resolveMemoryDreamingPluginConfig(currentConfig),
          cfg: currentConfig,
        });
        if (!config.enabled) {
          return ctx.trigger === "cron"
            ? { handled: true, reason: "memory-core: short-term dreaming disabled" }
            : undefined;
        }
        return await runShortTermDreamingPromotion({
          runInBackground: ctx.trigger === "cron" ? trackDreamingTask : undefined,
          agentId: ctx.agentId,
          workspaceDir: ctx.workspaceDir,
          cfg: currentConfig,
          config,
          logger: api.logger,
          subagent: api.runtime.subagent,
          narrativeTimeoutMs: api.runtime.agent.resolveAgentTimeoutMs({ cfg: currentConfig }),
          ...(typeof currentConfig.agents?.defaults?.timeoutSeconds === "number"
            ? {
                consolidationTimeoutMs: api.runtime.agent.resolveAgentTimeoutMs({
                  cfg: currentConfig,
                }),
              }
            : {}),
        });
      } catch (err) {
        api.logger.error(`memory-core: dreaming trigger failed: ${formatErrorMessage(err)}`);
        return undefined;
      }
    },
    { eligibleTriggers: ["heartbeat", "cron"] },
  );
}
