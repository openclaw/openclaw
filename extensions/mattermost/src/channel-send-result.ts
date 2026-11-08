import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { MattermostSendResult } from "./mattermost/send.js";

type MattermostOutboundContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

export function toMattermostOutboundResult(result: MattermostSendResult) {
  const { channelId, ...delivery } = result;
  return { ...delivery, target: { kind: "channel" as const, id: channelId } };
}

export function createMattermostDeliveryProgressReporter(
  onDeliveryResult: MattermostOutboundContext["onDeliveryResult"],
) {
  return onDeliveryResult
    ? async (result: MattermostSendResult) => {
        await onDeliveryResult(
          attachChannelToResult("mattermost", toMattermostOutboundResult(result)),
        );
      }
    : undefined;
}
