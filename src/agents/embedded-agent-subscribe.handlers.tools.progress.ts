import {
  asOptionalObjectRecord,
  asOptionalRecord as readRecordField,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  type AgentCommandOutputEventData,
  projectAgentToolActivity,
} from "../infra/agent-activity-events.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { peekAdjustedParamsForToolCall } from "./agent-tools.before-tool-call.state.js";
import { extractLiveExecOutput } from "./embedded-agent-subscribe.handlers.tools.results.js";
import {
  buildCommandItemId,
  buildCommandItemTitle,
  buildToolStartKey,
  emitAgentEventCallbackBestEffort,
  emitToolActivityEvent,
  emitTrackedItemEvent,
  isExecToolName,
  toolStartData,
} from "./embedded-agent-subscribe.handlers.tools.start.js";
import type {
  ExecLiveItemMetadata,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  capLiveExecResult,
  sanitizeToolResult,
  truncateLiveExecOutput,
} from "./embedded-agent-tool-results.js";
import type { AgentEvent } from "./runtime/index.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

type ChannelToolProgress = {
  text: string;
};

const LIVE_EXEC_UPDATE_MIN_INTERVAL_MS = 250;

function readChannelToolProgress(result: unknown): ChannelToolProgress | undefined {
  const progress = readRecordField(asOptionalObjectRecord(result)?.progress);
  // Only typed progress crosses into UI; tool output/details may contain private data.
  if (progress?.visibility !== "channel" || progress.privacy !== "public") {
    return undefined;
  }
  const text = readStringValue(progress.text)?.trim();
  if (!text) {
    return undefined;
  }
  return { text: truncateLiveExecOutput(text) };
}

function prepareLiveExecUpdate(
  ctx: ToolHandlerContext,
  toolCallId: string,
  partialResult: unknown,
  itemMetadata: ExecLiveItemMetadata,
): { update?: { result: unknown }; emitItems: boolean } {
  const now = Date.now();
  const state = (ctx.state.execLiveUpdateStateById ??= new Map());
  const previous = state.get(toolCallId);
  if (previous && now - previous.lastEmittedAtMs < LIVE_EXEC_UPDATE_MIN_INTERVAL_MS) {
    const emitItems =
      previous.itemMetadata.name !== itemMetadata.name ||
      previous.itemMetadata.meta !== itemMetadata.meta ||
      previous.itemMetadata.commandBearing !== itemMetadata.commandBearing ||
      previous.itemMetadata.hideFromChannelProgress !== itemMetadata.hideFromChannelProgress;
    if (emitItems) {
      previous.itemMetadata = itemMetadata;
    }
    return { emitItems };
  }
  // Skip payload work inside the throttle; stamp after preparation so slow
  // redaction cannot make the next detailed frame arrive back-to-back.
  const result = capLiveExecResult(sanitizeToolResult(partialResult));
  state.set(toolCallId, { lastEmittedAtMs: Date.now(), itemMetadata });
  return { update: { result }, emitItems: true };
}

/** Handles partial tool output and emits throttled live UI updates. */
export function handleToolExecutionUpdate(
  ctx: ToolHandlerContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
    hideFromChannelProgress?: boolean;
  },
) {
  const toolName = normalizeToolPolicyName(evt.toolName);
  const toolCallId = evt.toolCallId;
  const startData = toolStartData.get(buildToolStartKey(ctx.params.runId, toolCallId));
  const parentToolCallId = startData?.parentToolCallId;
  const args = peekAdjustedParamsForToolCall(toolCallId, ctx.params.runId) ?? startData?.args;
  if (startData && evt.hideFromChannelProgress === true) {
    startData.hideFromChannelProgress = true;
  }
  const explicitHideFromChannelProgress =
    evt.hideFromChannelProgress === true || startData?.hideFromChannelProgress === true;
  const partial = evt.partialResult;
  const isExecTool = isExecToolName(toolName);
  const toolMeta = ctx.state.toolMetaById.get(toolCallId);
  const execProgress = isExecTool
    ? prepareLiveExecUpdate(ctx, toolCallId, partial, {
        name: toolName,
        meta: toolMeta?.meta,
        commandBearing: toolMeta?.commandBearing,
        hideFromChannelProgress: explicitHideFromChannelProgress,
      })
    : undefined;
  const execUpdate = execProgress?.update;
  const liveResult = isExecTool ? execUpdate?.result : sanitizeToolResult(partial);
  const toolProgress = isExecTool ? undefined : readChannelToolProgress(liveResult);
  const itemData = {
    ...projectAgentToolActivity({
      toolCallId,
      name: toolName,
      phase: "update",
      args,
      meta: toolMeta?.meta,
      hideFromChannelProgress: explicitHideFromChannelProgress,
    }),
    commandBearing: toolMeta?.commandBearing,
    ...(toolProgress ? { progressText: toolProgress.text, meta: undefined } : {}),
  };
  const hideFromChannelProgress = explicitHideFromChannelProgress;
  // Typed progress already has a sanitized path; suppress duplicate raw previews.
  const emitDetailedLiveUpdate = !toolProgress && (!isExecTool || execUpdate !== undefined);
  if (emitDetailedLiveUpdate) {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        partialResult: liveResult,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });
  }
  emitTrackedItemEvent(ctx, itemData, execProgress?.emitItems);
  if (!toolProgress) {
    emitAgentEventCallbackBestEffort(ctx, {
      stream: "tool",
      data: {
        phase: "update",
        name: toolName,
        toolCallId,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
    });
  }
  if (isExecTool) {
    const output = extractLiveExecOutput(liveResult);
    if (emitDetailedLiveUpdate && output) {
      const outputData: AgentCommandOutputEventData = {
        itemId: buildCommandItemId(toolCallId),
        phase: "delta",
        title: buildCommandItemTitle(toolName, toolMeta?.meta),
        toolCallId,
        name: toolName,
        output,
        status: "running",
      };
      emitToolActivityEvent(ctx, {
        stream: "command_output",
        data: outputData,
      });
    }
  }
}
