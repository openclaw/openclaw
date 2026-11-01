import { getRuntimeConfig } from "../../config/config.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-admitted-read.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import {
  scheduleSkillExperienceReview,
  scheduleDailyWorkshopMaintenance,
} from "../../skills/workshop/experience-review-default.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import { projectSessionForkRequester } from "../session-fork-requester.js";
import {
  completedTurnMessageAnchor,
  type CompletedTurnMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import { SKILL_WORKSHOP_TOOL_NAME } from "../skill-workshop-prompt.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";
import { bindAgentHarnessHookMessages, takeHookMessageLoader } from "./lifecycle-hook-messages.js";

const log = createSubsystemLogger("agents/harness");

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  [completedTurnMessageAnchor]?: CompletedTurnMessageAnchor;
  /** Exact completed-turn boundary; context loading stays off the foreground path. */
  skillExperienceReviewSource?: Pick<
    TranscriptEntryAnchor,
    "agentId" | "sessionId" | "sessionKey" | "storePath" | "entryId"
  >;
  ctx: BaseAgentEndSideEffectsParams["ctx"] & {
    authProfileId?: string;
    /** @deprecated Set `event.modelIterations`. Supported through 2026-12-31. */
    modelIterations?: number;
    modelContextWindowTokens?: number;
    /** @deprecated Set `toolNames`. Supported through 2026-12-31. */
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    foregroundPromptContext?: EmbeddedForegroundPromptContext;
  };
};

/**
 * Settles the run's facts once, before core and plugin consumers read them: the skill-usage
 * receipt is consumed here, and the retired context fields map onto their public replacements.
 */
function prepareAgentEnd(params: AgentEndSideEffectsParams): AgentEndSideEffectsParams {
  const { modelIterations, skillWorkshopAvailable, ...ctx } = params.ctx;
  for (const [field, replacement, used] of [
    ["modelIterations", "event.modelIterations", modelIterations !== undefined],
    ["skillWorkshopAvailable", "ctx.toolNames", skillWorkshopAvailable !== undefined],
  ] as const) {
    if (used) {
      warnPluginSdkDeprecation({
        family: "agent-end-side-effects",
        method: `ctx.${field}`,
        replacement,
      });
    }
  }
  const { modelIterations: reportedIterations, ...reported } = params.event;
  const iterations = reportedIterations ?? modelIterations;
  const skillsUsed = consumeRunSkillUsage(ctx.runId).map(({ name, source, activation }) => ({
    name,
    source,
    activation,
  }));
  const loadMessages = takeHookMessageLoader(params.event);
  const event = {
    ...reported,
    ...(iterations !== undefined ? { modelIterations: iterations } : {}),
    ...(skillsUsed.length > 0 ? { skillsUsed } : {}),
  };
  return {
    ...params,
    event: loadMessages ? bindAgentHarnessHookMessages(event, loadMessages) : event,
    ctx:
      ctx.toolNames === undefined && skillWorkshopAvailable === true
        ? { ...ctx, toolNames: [SKILL_WORKSHOP_TOOL_NAME] }
        : ctx,
  };
}

function runCoreAgentEndSideEffects(
  params: AgentEndSideEffectsParams,
  read: "native" | "worker",
): void | Promise<void> {
  const foregroundPromptContext = params.ctx.foregroundPromptContext;
  if (!foregroundPromptContext) {
    return;
  }
  // Hook contexts do not always carry the config; the runtime config is the owner at this boundary.
  const config = params.ctx.config ?? getRuntimeConfig();
  const schedule = (anchor: TranscriptEntryAnchor | undefined) => {
    if (!anchor) {
      return;
    }
    // The review reads only the turn's requester identity, never its live capabilities.
    const { foregroundPromptContext: _turn, ...hookCtx } = params.ctx;
    scheduleSkillExperienceReview({
      event: params.event,
      ctx: {
        ...hookCtx,
        agentId: foregroundPromptContext.agentId,
        trigger: params.ctx.trigger ?? foregroundPromptContext.trigger,
        requester: projectSessionForkRequester(foregroundPromptContext),
      },
      config,
      source: anchor,
    });
  };
  const failed = (error: unknown) => {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
  };
  try {
    scheduleDailyWorkshopMaintenance(config, foregroundPromptContext.agentId);
    // CLI hook contexts omit toolNames, so isEligibleContext rejects them.
    const source = params.skillExperienceReviewSource;
    if (!source) {
      return;
    }
    if (read === "worker") {
      const committed = params[completedTurnMessageAnchor];
      const assertCurrent =
        committed?.assertCurrent ?? captureOwnedTranscriptWriteAssertion(source);
      assertCurrent();
      if (committed) {
        schedule(committed.anchor);
        return;
      }
      return readActiveTranscriptEntryAnchorAsync(source)
        .then((anchor) => {
          assertCurrent();
          schedule(anchor);
        })
        .catch(failed);
    }
    schedule(readActiveTranscriptEntryAnchor(source));
  } catch (error) {
    failed(error);
  }
}

/** @deprecated Await runAgentEndSideEffectsAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  warnPluginSdkDeprecation({
    family: "agent-end-side-effects",
    method: "runAgentEndSideEffects",
    replacement: "await runAgentEndSideEffectsAsync",
  });
  const prepared = prepareAgentEnd(params);
  void runCoreAgentEndSideEffects(prepared, "native");
  runAgentHarnessAgentEndHook(prepared);
}

/** Keep the turn lease through anchor preparation, then start plugin hooks without waiting. */
export async function runAgentEndSideEffectsAsync(
  params: AgentEndSideEffectsParams,
): Promise<void> {
  const prepared = prepareAgentEnd(params);
  await runCoreAgentEndSideEffects(prepared, "worker");
  runAgentHarnessAgentEndHook(prepared);
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  const prepared = prepareAgentEnd(params);
  await runCoreAgentEndSideEffects(prepared, "worker");
  await awaitAgentHarnessAgentEndHook(prepared);
}
