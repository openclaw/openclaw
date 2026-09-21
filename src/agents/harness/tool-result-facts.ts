import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging.types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "../embedded-agent-tool-media.js";
import {
  isToolResultError,
  resolveToolResultFailureKind,
  type ToolResultFailureKind,
} from "../tool-result-error.js";

/** Presentation can add a failure, but cannot erase a failure from execution. */
export function resolveAgentHarnessToolResultPresentation(params: {
  result: AgentToolResult<unknown>;
  executionIsError: boolean;
  executionFailureKind?: ToolResultFailureKind;
}) {
  const presentationFailureKind = resolveToolResultFailureKind(params.result);
  const failureKind = params.executionFailureKind ?? presentationFailureKind;
  const result =
    params.executionFailureKind && params.executionFailureKind !== presentationFailureKind
      ? {
          ...params.result,
          details: {
            ...(isRecord(params.result.details) ? params.result.details : {}),
            status: params.executionFailureKind,
          },
        }
      : params.result;
  return {
    result,
    isError: params.executionIsError || isToolResultError(params.result),
    failureKind,
  };
}

/** Records a delivery already established by the caller's messaging receipt. */
export function recordAgentHarnessMessagingDelivery(params: {
  facts: AgentHarnessMessagingDeliveryFacts;
  sourceReplyPayload?: MessagingToolSourceReplyPayload;
  target?: MessagingToolSend;
  text?: string;
  mediaUrls?: string[];
  sourceReplyFinal?: boolean;
}): MessagingToolSend | MessagingToolSourceReplyPayload | undefined {
  const { facts, sourceReplyPayload, target, text, mediaUrls = [], sourceReplyFinal } = params;
  facts.didSendViaMessagingTool = true;
  const finality = sourceReplyFinal !== undefined ? { sourceReplyFinal } : {};
  if (sourceReplyPayload) {
    const record = { ...sourceReplyPayload, ...finality };
    facts.messagingToolSourceReplyPayloads.push(record);
    return record;
  }
  if (text) {
    facts.messagingToolSentTexts.push(text);
  }
  facts.messagingToolSentMediaUrls.push(...mediaUrls);
  if (!target) {
    return undefined;
  }
  const record = {
    ...target,
    ...(text ? { text } : {}),
    ...(mediaUrls.length ? { mediaUrls } : {}),
    ...finality,
  };
  facts.messagingToolSentTargets.push(record);
  return record;
}

/** Result presentation supplies artifacts; the concrete tool supplies path trust. */
export function recordAgentHarnessToolResultMedia(params: {
  facts: AgentHarnessToolMediaFacts;
  toolName?: string;
  result: unknown;
  mediaTrustResult?: unknown;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
}) {
  const media = extractToolResultMediaArtifact(params.result);
  if (!media) {
    return undefined;
  }
  const mediaUrls = filterToolResultMediaUrls(
    params.toolName,
    media.mediaUrls,
    params.mediaTrustResult ?? params.result,
    params.trustedLocalMediaToolNames,
  );
  const seen = new Set(params.facts.toolMediaUrls);
  for (const url of mediaUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      params.facts.toolMediaUrls.push(url);
    }
  }
  if (media.audioAsVoice) {
    params.facts.toolAudioAsVoice = true;
  }
  return { ...media, mediaUrls };
}

export type AgentHarnessMessagingDeliveryFacts = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
};

export type AgentHarnessToolMediaFacts = {
  toolMediaUrls: string[];
  toolAudioAsVoice?: boolean;
};
