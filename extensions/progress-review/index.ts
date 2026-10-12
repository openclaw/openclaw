import { definePluginEntry, type PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { createProgressReviewController, type ProgressReviewSchedule } from "./src/controller.js";
import {
  buildReviewMessage,
  DELIVERY_PREFIX,
  parseReviewOutput,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TIMEOUT_MS,
} from "./src/review.js";

const DEFAULT_SCHEDULE: ProgressReviewSchedule = { everyTurns: 10, everyMinutes: 20 };
const ADVICE_TTL_MS = 24 * 60 * 60 * 1000;
// Heartbeat, cron, memory-flush and overflow runs are not user-directed work.
const REVIEWED_TRIGGERS = new Set([undefined, "user", "manual"]);

function resolveSchedule(config: Record<string, unknown> | undefined): ProgressReviewSchedule {
  const read = (key: keyof ProgressReviewSchedule) => {
    const value = config?.[key];
    return typeof value === "number" ? value : DEFAULT_SCHEDULE[key];
  };
  return { everyTurns: read("everyTurns"), everyMinutes: read("everyMinutes") };
}

export default definePluginEntry({
  id: "progress-review",
  name: "Progress Review",
  description:
    "Experimental: periodically reviews a conversation's recent agent work and gives the agent one short correction on its next turn.",
  register(api) {
    const schedule = resolveSchedule(api.pluginConfig);
    if (schedule.everyTurns === 0 && schedule.everyMinutes === 0) {
      api.logger.warn(
        "progress-review: both everyTurns and everyMinutes are 0, so no reviews will run. Set either to a positive value.",
      );
      return;
    }
    // Reviews must not inherit the finished turn's authority, which closes with the turn.
    // The service scheduler runs them under the plugin's own lifetime instead.
    let scheduler: PluginServiceSchedulerV1 | undefined;
    const controller = createProgressReviewController({
      schedule,
      logger: api.logger,
      runInBackground: (sessionKey, run) => {
        if (!scheduler || scheduler.signal.aborted) {
          return false;
        }
        scheduler.schedule({ id: `review:${sessionKey}`, delayMs: 0, run });
        return true;
      },
      review: async ({ agentId, evidence, previousAdvice, signal }) => {
        const result = await api.runtime.subagent.complete({
          agentId,
          message: buildReviewMessage({ evidence, previousAdvice }),
          extraSystemPrompt: REVIEW_SYSTEM_PROMPT,
          timeoutMs: REVIEW_TIMEOUT_MS,
          signal: scheduler ? AbortSignal.any([signal, scheduler.signal]) : signal,
        });
        return parseReviewOutput(result.text);
      },
      deliver: async ({ agentId, sessionKey, finding, reviewId }) => {
        const result = await api.session.workflow.enqueueNextTurnInjection({
          sessionKey,
          agentId,
          text: `${DELIVERY_PREFIX}\n\n${finding}`,
          idempotencyKey: `progress-review:${reviewId}`,
          ttlMs: ADVICE_TTL_MS,
        });
        return result.enqueued;
      },
    });

    api.registerService({
      apiVersion: 2,
      id: "progress-review",
      start: (ctx) => {
        scheduler = ctx.scheduler;
      },
      stop: () => {
        scheduler = undefined;
        controller.forget();
      },
    });

    api.on("agent_end", (event, ctx) => {
      if (!ctx.sessionKey || !ctx.agentId || !REVIEWED_TRIGGERS.has(ctx.trigger)) {
        return;
      }
      controller.turnEnded({
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        durationMs: event.durationMs,
        messages: event.messages,
      });
    });

    api.registerRuntimeLifecycle({
      id: "progress-review",
      description: "Cancels in-flight progress reviews when sessions or the plugin go away.",
      cleanup: ({ sessionKey }) => controller.forget(sessionKey),
      dispose: () => controller.forget(),
    });
  },
});
