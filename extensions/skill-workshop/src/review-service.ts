import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import {
  hasActiveSessionRuns,
  listWorkshopChanges,
} from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  createSkillExperienceReviewScheduler,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";
import { getWorkshopRuntime, readWorkshopRuntimeConfig, workshopLog } from "./runtime.js";

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000;
const lastMaintenanceByAgent = new Map<string, number>();
// The running service's Gateway-owned scheduler. Its callbacks run in this plugin's call scope,
// which review runs need; a detached timer would lose it. Stopping the service (Gateway
// shutdown, restart, or plugin unload) aborts its signal and waits for running callbacks.
let serviceScheduler: PluginServiceSchedulerV1 | undefined;

const defaultScheduler = createSkillExperienceReviewScheduler({
  isSystemActive: hasActiveSessionRuns,
  setTimer: (delayMs, run) => {
    if (!serviceScheduler) {
      workshopLog().debug("experience review skipped: reason=service-stopped");
      return () => {};
    }
    const job = serviceScheduler.schedule({ id: randomUUID(), delayMs, run });
    return () => job.cancel();
  },
  runReview: async (candidate, signal) => {
    const { runSkillExperienceReview } = await import("./experience-review.js");
    await runSkillExperienceReview(candidate, { abortSignal: signal });
  },
});

/** Counts the finished turn toward a background review; never affects the turn's result. */
function scheduleSkillExperienceReview(
  params: Omit<SkillExperienceReviewParams, "workshopMutated">,
): void {
  const runId = params.ctx.runId?.trim();
  if (resolveSkillWorkshopConfig(params.config).autonomous.mode === "off" || !runId) {
    defaultScheduler.schedule(params);
    return;
  }
  // The change feed records the run that made each edit; a foreground turn that saved
  // its own learning resets the session's review counter.
  void listWorkshopChanges(params.ctx.agentId, { runId, limit: 1 })
    .then((changes) =>
      defaultScheduler.schedule({ ...params, workshopMutated: changes.length > 0 }),
    )
    .catch((error: unknown) => {
      workshopLog().warn(`skill experience review scheduling failed: ${formatErrorMessage(error)}`);
    });
}

/**
 * Explicit Stop: drops every stopped session's queued review, aborts its in-flight review, and
 * suppresses the stopped runs until their own aborted completions arrive. Best-effort so review
 * bookkeeping never fails Stop; `run_stopped` fires only after the Stop's authority is confirmed.
 */
function stopSkillExperienceReview(params: {
  sessions: readonly { agentId?: string; sessionKey?: string }[];
  runIds: Iterable<string>;
}): void {
  for (const session of params.sessions) {
    if (!session.agentId || !session.sessionKey) {
      continue;
    }
    try {
      defaultScheduler.cancelSession({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
      });
    } catch (error) {
      workshopLog().warn(
        `skill experience review cancellation failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  try {
    defaultScheduler.suppressRuns(params.runIds);
  } catch (error) {
    workshopLog().warn(`skill experience review suppression failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Daily Workshop maintenance in auto mode, at most once a day per agent: archive long-unused
 * learned skills, then diet one oversized skill. An agent whose tool policy denies
 * skill_workshop opted out and gets no maintenance. Runs detached from the finished turn and
 * never affects its result. It runs as a job of the plugin service's scheduler, so a graceful
 * restart waits for a running archive while the stop signal ends the diet's model call.
 */
function scheduleDailyWorkshopMaintenance(config: OpenClawConfig, agentId: string): void {
  if (resolveSkillWorkshopConfig(config).autonomous.mode !== "auto") {
    return;
  }
  const scheduler = serviceScheduler;
  if (!scheduler) {
    workshopLog().debug("workshop maintenance skipped: reason=service-stopped");
    return;
  }
  const nowMs = Date.now();
  const lastMs = lastMaintenanceByAgent.get(agentId);
  if (lastMs !== undefined && nowMs - lastMs < MAINTENANCE_INTERVAL_MS) {
    return;
  }
  lastMaintenanceByAgent.set(agentId, nowMs);
  scheduler.schedule({
    id: `maintenance:${agentId}`,
    delayMs: 0,
    run: () => runDailyWorkshopMaintenance(config, agentId, nowMs, scheduler.signal),
  });
}

async function runDailyWorkshopMaintenance(
  config: OpenClawConfig,
  agentId: string,
  nowMs: number,
  abortSignal: AbortSignal,
): Promise<void> {
  try {
    // Maintenance loads the library and runtime policy; most turns never need them.
    const runtime = getWorkshopRuntime();
    const { isSkillWorkshopDeniedForAgent } = await import("./tool-policy-diagnostic.js");
    if (
      await isSkillWorkshopDeniedForAgent(
        (params) => runtime.agent.explainToolAvailability(params),
        config,
        agentId,
      )
    ) {
      return;
    }
    const { archiveUnusedWorkshopSkills } = await import("./unused-archive.js");
    const archived = await archiveUnusedWorkshopSkills(config, agentId, nowMs).catch(
      (error: unknown) => {
        workshopLog().warn(`unused skill archive failed: ${formatErrorMessage(error)}`);
        return [];
      },
    );
    if (archived.length > 0) {
      workshopLog().info(
        `archived ${archived.length} unused learned skill(s) for ${agentId}: ${archived.map((change) => change.skillName).join(", ")}`,
      );
    }
    // A stopping service waited for the archive; it skips the diet's model call.
    if (abortSignal.aborted) {
      return;
    }
    const { runWorkshopSkillDiet } = await import("./skill-diet.js");
    const dieted = await runWorkshopSkillDiet({ config, agentId, nowMs, abortSignal });
    if (dieted) {
      workshopLog().info(
        `dieted learned skill ${dieted.skillName} for ${agentId}: ${dieted.summary}`,
      );
    }
  } catch (error) {
    workshopLog().warn(`workshop maintenance failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * Background learning: after each finished turn, daily maintenance and the review counter;
 * an explicit Stop drops that session's queued and in-flight reviews.
 */
export function registerSkillWorkshopReview(api: OpenClawPluginApi): void {
  api.registerService({
    apiVersion: 2,
    id: "skill-workshop-maintenance",
    start: (ctx) => {
      serviceScheduler = ctx.scheduler;
    },
    stop: (ctx) => {
      if (serviceScheduler === ctx.scheduler) {
        serviceScheduler = undefined;
      }
    },
  });
  api.on("agent_end", (event, ctx) => {
    const agentId = ctx.agentId;
    if (!agentId) {
      return;
    }
    try {
      const config = readWorkshopRuntimeConfig();
      scheduleDailyWorkshopMaintenance(config, agentId);
      const { completedTurn, sessionKey } = ctx;
      // Runtimes that recorded no reviewable final entry leave completedTurn unset.
      if (!completedTurn || !sessionKey) {
        return;
      }
      scheduleSkillExperienceReview({
        event,
        ctx: { ...ctx, agentId },
        config,
        source: { agentId, sessionKey, ...completedTurn },
      });
    } catch (error) {
      workshopLog().warn(`agent end side effect failed: ${String(error)}`);
    }
  });
  api.on("run_stopped", (event) => {
    stopSkillExperienceReview({ sessions: event.sessions, runIds: event.runIds });
  });
}
