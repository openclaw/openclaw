import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig, NextcloudTalkInboundReaction } from "./types.js";

export async function handleNextcloudTalkInboundReaction(params: {
  reaction: NextcloudTalkInboundReaction;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number }) => void;
}): Promise<void> {
  const { reaction, runtime, statusSink } = params;
  statusSink?.({ lastInboundAt: reaction.timestamp });
  runtime.log?.(
    `nextcloud-talk: TODO inbound reaction dispatch skipped room=${reaction.roomToken} messageId=${reaction.messageId} op=${reaction.operation} emoji=${reaction.emoji}`,
  );
}
