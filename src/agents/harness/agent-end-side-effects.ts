import { getRuntimeConfig } from "../../config/config.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import {
  scheduleSkillExperienceReview,
  scheduleUnusedWorkshopSkillArchive,
} from "../../skills/workshop/experience-review-default.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import {
  completedTurnMessageAnchor,
  type CompletedTurnMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

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
    modelIterations?: number;
    modelContextWindowTokens?: number;
    skillWorkshopAvailable?: boolean;
    compacted?: boolean;
    foregroundPromptContext?: EmbeddedForegroundPromptContext;
  };
};

function runCoreAgentEndSideEffects(
  params: AgentEndSideEffectsParams,
  read: "native" | "worker",
): void | Promise<void> {
  const usedSkills = consumeRunSkillUsage(params.ctx.runId);
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
    const ctx = { ...params.ctx, foregroundPromptContext };
    scheduleSkillExperienceReview({
      event: params.event,
      ctx,
      usedSkills,
      config,
      source: anchor,
    });
  };
  const failed = (error: unknown) => {
    // Side effects are observational; failures must not change the completed run result.
    log.warn(`skill experience review scheduling failed: ${String(error)}`);
  };
  try {
    scheduleUnusedWorkshopSkillArchive(config, foregroundPromptContext.agentId);
    // CLI hook contexts omit skillWorkshopAvailable, so isEligibleContext rejects them.
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

/** @deprecated Use runAgentEndSideEffectsAsync; retained until the next Plugin SDK major. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  void runCoreAgentEndSideEffects(params, "native");
  runAgentHarnessAgentEndHook(params);
}

/** Keep the turn lease through anchor preparation, then start plugin hooks without waiting. */
export async function runAgentEndSideEffectsAsync(
  params: AgentEndSideEffectsParams,
): Promise<void> {
  await runCoreAgentEndSideEffects(params, "worker");
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  await runCoreAgentEndSideEffects(params, "worker");
  await awaitAgentHarnessAgentEndHook(params);
}
