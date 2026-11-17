import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-admitted-read.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import type { EmbeddedForegroundPromptContext } from "../embedded-agent-runner/run/params.js";
import {
  completedTurnMessageAnchor,
  type CompletedTurnMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";
import { bindAgentHarnessHookMessages, takeHookMessageLoader } from "./lifecycle-hook-messages.js";

const log = createSubsystemLogger("agents/harness");

type CompletedTurnSource = Pick<
  TranscriptEntryAnchor,
  "agentId" | "sessionId" | "sessionKey" | "storePath" | "entryId"
>;

type BaseAgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];
type AgentEndSideEffectsParams = Omit<BaseAgentEndSideEffectsParams, "ctx"> & {
  [completedTurnMessageAnchor]?: CompletedTurnMessageAnchor;
  /**
   * The transcript entry that ended the turn. Hooks receive it as `ctx.completedTurn`; omit it
   * when the turn left no reviewable final entry.
   */
  completedTurnSource?: CompletedTurnSource;
  /** @deprecated Set `completedTurnSource`. Supported through 2026-12-31. */
  skillExperienceReviewSource?: CompletedTurnSource;
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
  const { skillExperienceReviewSource, ...rest } = params;
  const { modelIterations, skillWorkshopAvailable, ...ctx } = params.ctx;
  for (const [method, replacement, used] of [
    ["ctx.modelIterations", "event.modelIterations", modelIterations !== undefined],
    ["ctx.skillWorkshopAvailable", "ctx.toolNames", skillWorkshopAvailable !== undefined],
    [
      "skillExperienceReviewSource",
      "completedTurnSource",
      skillExperienceReviewSource !== undefined,
    ],
  ] as const) {
    if (used) {
      warnPluginSdkDeprecation({ family: "agent-end-side-effects", method, replacement });
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
  const completedTurnSource = params.completedTurnSource ?? skillExperienceReviewSource;
  return {
    ...rest,
    ...(completedTurnSource ? { completedTurnSource } : {}),
    event: loadMessages ? bindAgentHarnessHookMessages(event, loadMessages) : event,
    ctx:
      ctx.toolNames === undefined && skillWorkshopAvailable === true
        ? { ...ctx, toolNames: ["skill_workshop"] }
        : ctx,
  };
}

function warnSideEffectFailure(error: unknown): void {
  // Side effects are observational; failures must not change the completed run result.
  log.warn(`agent end side effect failed: ${String(error)}`);
}

/** Deprecated synchronous path: reads the final entry's anchor on this thread. */
function readCompletedTurnNative(
  params: AgentEndSideEffectsParams,
): TranscriptEntryAnchor | undefined {
  if (!params.completedTurnSource) {
    return undefined;
  }
  try {
    return readActiveTranscriptEntryAnchor(params.completedTurnSource);
  } catch (error) {
    warnSideEffectFailure(error);
    return undefined;
  }
}

/**
 * Resolves the committed anchor of the turn's final entry once, for core and plugin consumers.
 * The read keeps the turn lease's write assertion, so a superseded turn yields none.
 */
async function readCompletedTurn(
  params: AgentEndSideEffectsParams,
): Promise<TranscriptEntryAnchor | undefined> {
  const source = params.completedTurnSource;
  if (!source) {
    return undefined;
  }
  try {
    const committed = params[completedTurnMessageAnchor];
    const assertCurrent = committed?.assertCurrent ?? captureOwnedTranscriptWriteAssertion(source);
    assertCurrent();
    if (committed) {
      return committed.anchor;
    }
    const anchor = await readActiveTranscriptEntryAnchorAsync(source);
    assertCurrent();
    return anchor;
  } catch (error) {
    warnSideEffectFailure(error);
    return undefined;
  }
}

function withCompletedTurn(
  params: AgentEndSideEffectsParams,
  anchor: TranscriptEntryAnchor | undefined,
): AgentEndSideEffectsParams {
  return anchor
    ? {
        ...params,
        ctx: {
          ...params.ctx,
          completedTurn: { sessionId: anchor.sessionId, entryId: anchor.entryId },
        },
      }
    : params;
}

async function prepareWithCompletedTurn(
  params: AgentEndSideEffectsParams,
): Promise<AgentEndSideEffectsParams> {
  const prepared = prepareAgentEnd(params);
  return withCompletedTurn(prepared, await readCompletedTurn(prepared));
}

/** @deprecated Await runAgentEndSideEffectsAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  warnPluginSdkDeprecation({
    family: "agent-end-side-effects",
    method: "runAgentEndSideEffects",
    replacement: "await runAgentEndSideEffectsAsync",
  });
  const prepared = prepareAgentEnd(params);
  runAgentHarnessAgentEndHook(withCompletedTurn(prepared, readCompletedTurnNative(prepared)));
}

/** Keep the turn lease through anchor preparation, then start plugin hooks without waiting. */
export async function runAgentEndSideEffectsAsync(
  params: AgentEndSideEffectsParams,
): Promise<void> {
  runAgentHarnessAgentEndHook(await prepareWithCompletedTurn(params));
}

/** Runs agent-end side effects and waits for plugin/core completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  await awaitAgentHarnessAgentEndHook(await prepareWithCompletedTurn(params));
}
