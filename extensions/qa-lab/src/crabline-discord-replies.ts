import type { StartedOpenClawCrablineCorrelatedAdapter } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readQaJsonResponse } from "./ignored-response-body.js";
import { readLiveQaChannelAccounts } from "./live-transports/shared/live-channel-status.js";
import {
  waitForQaTransportCondition,
  type QaTransportAdapter,
  type QaTransportState,
} from "./qa-transport.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type { QaBusInboundMessageInput, QaBusMessage } from "./runtime-api.js";

export function createCrablineDiscordReplyReader(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  state: QaTransportState;
  targets: ReadonlyMap<string, Pick<QaBusInboundMessageInput, "conversation" | "threadId">>;
}): NonNullable<QaTransportAdapter["waitForCompletedReply"]> {
  const { state } = params;
  return async ({ inbound, gateway, timeoutMs = 60_000 }) => {
    const deadline = Date.now() + timeoutMs;
    await waitForQaTransportCondition(() => {
      const messages = state.getSnapshot().messages;
      const inboundIndex = messages.findIndex(
        (message) => message.id === inbound.id && message.direction === "inbound",
      );
      return inboundIndex >= 0 &&
        messages
          .slice(inboundIndex + 1)
          .some(
            (message) =>
              message.direction === "outbound" && message.accountId === inbound.accountId,
          )
        ? true
        : undefined;
    }, timeoutMs);
    await waitForQaTransportCondition(
      async () => {
        const accounts = await readLiveQaChannelAccounts(gateway, "discord", {
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        const account = accounts.find((entry) => entry.accountId === inbound.accountId);
        return account?.running === true &&
          account.connected === true &&
          account.restartPending !== true &&
          account.busy === false &&
          account.activeRuns === 0
          ? true
          : undefined;
      },
      Math.max(1, deadline - Date.now()),
    );
    const manifest = params.adapter.manifest;
    if (manifest.provider !== "discord") {
      throw new Error("retained Discord replies require the Discord adapter");
    }
    const replies: QaBusMessage[] = [];
    for (const [channelId, target] of params.targets) {
      const query = new URLSearchParams({ after: inbound.id, limit: "100" });
      const { response, release } = await fetchWithSsrFGuard({
        url: `${manifest.endpoints.apiRoot}/v10/channels/${channelId}/messages?${query}`,
        init: { headers: { authorization: `Bot ${manifest.botToken}` } },
        policy: { allowPrivateNetwork: true },
        timeoutMs: Math.max(1, deadline - Date.now()),
        auditContext: "qa-lab-crabline-discord-retained-reply",
      });
      const messages = await readQaJsonResponse<unknown>(
        response,
        release,
        "Discord retained reply read failed",
      );
      if (!Array.isArray(messages) || messages.length >= 100) {
        throw new Error("Discord retained reply read was invalid or truncated");
      }
      for (const message of messages) {
        if (
          !isRecord(message) ||
          !isRecord(message.author) ||
          message.author.id !== manifest.botUserId
        ) {
          continue;
        }
        const id = readStringValue(message.id);
        if (!id) {
          throw new Error("Discord retained reply omitted its message id");
        }
        const replyToId = isRecord(message.message_reference)
          ? readStringValue(message.message_reference.message_id)
          : undefined;
        replies.push({
          id,
          accountId: params.adapter.accountId,
          direction: "outbound",
          ...target,
          senderId: manifest.botUserId,
          text: readStringValue(message.content) ?? "",
          timestamp: Date.parse(String(message.timestamp)),
          ...(replyToId ? { replyToId } : {}),
          reactions: [],
        });
      }
    }
    replies.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
    const reply = replies.at(-1);
    if (!reply) {
      throw new Error(`Discord inbound ${inbound.id} completed without a retained reply`);
    }
    const failure = extractQaFailureReplyText(reply);
    if (failure) {
      throw new Error(failure);
    }
    return reply;
  };
}
