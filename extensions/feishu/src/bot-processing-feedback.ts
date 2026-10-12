import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import type { FeishuProcessingMessage } from "./processing-indicator.js";

export type FeishuMessageParams = {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  preparedContent?: string;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  channelRuntime?: PluginRuntime["channel"];
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
  processingClaim?: FeishuMessageProcessingClaim;
  messageDedupeKey?: string;
  turnAdoptionLifecycle?: FeishuIngressLifecycle;
  processingStatus?: FeishuProcessingMessage;
  onQueuedSettled?: () => void;
  trackTask?: (task: Promise<void>) => void;
};

export async function withFeishuProcessingFeedback(
  params: FeishuMessageParams,
  handleTurn: (params: FeishuMessageParams) => Promise<void>,
): Promise<void> {
  let runIncluded = false;
  let deferred = false;
  const { processingStatus, turnAdoptionLifecycle } = params;
  const statusLifecycle = turnAdoptionLifecycle
    ? {
        ...turnAdoptionLifecycle,
        onRunIncluded: (run: { runId: string; completion: Promise<void> }) => {
          runIncluded = true;
          processingStatus?.included(run);
          turnAdoptionLifecycle.onRunIncluded?.(run);
        },
        onDeferred: () => {
          const accepted = turnAdoptionLifecycle.onDeferred();
          if (accepted !== false) {
            deferred = true;
          }
          return accepted;
        },
      }
    : undefined;

  const onQueuedSettled = () => {
    if (!runIncluded) {
      processingStatus?.settled();
    }
  };
  try {
    await handleTurn({
      ...params,
      turnAdoptionLifecycle: statusLifecycle,
      onQueuedSettled,
    });
  } finally {
    if (!runIncluded && !deferred) {
      params.processingStatus?.settled();
    }
  }
}

export function bindFeishuProcessingReplyLifecycle(
  lifecycle: FeishuIngressLifecycle | undefined,
  options?: {
    processingStatus?: FeishuProcessingMessage;
    onRunIncluded?: FeishuIngressLifecycle["onRunIncluded"];
    onSettled?: () => void;
  },
) {
  if (!lifecycle) {
    return {};
  }
  const bound = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
  return {
    abortSignal: lifecycle?.abortSignal,
    ...(bound
      ? {
          turnAdoptionLifecycle: {
            ...bound,
            ...(options
              ? {
                  onAdopted: async () => {
                    await bound.onAdopted();
                    options.processingStatus?.queued();
                  },
                  onDeferred: () => {
                    const accepted = lifecycle.onDeferred();
                    if (accepted !== false) {
                      options.processingStatus?.queued();
                    }
                    return accepted;
                  },
                  onRunIncluded: options.onRunIncluded,
                  onSettled: options.onSettled,
                }
              : {}),
          },
        }
      : {}),
  };
}
