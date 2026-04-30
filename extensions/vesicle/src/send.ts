import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-runtime";
import { resolveVesicleAccount, type ResolvedVesicleAccount } from "./accounts.js";
import { createVesicleClient, type VesicleClient } from "./client.js";
import { parseVesicleTarget } from "./targets.js";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  type VesicleErrorEnvelope,
  type VesicleMessageTextResponse,
} from "./types.js";

export type VesicleSendResult = {
  messageId: string;
  to: string;
};

export type VesicleSendOpts = {
  accountId?: string | null;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
  account?: ResolvedVesicleAccount;
  client?: Pick<VesicleClient, "sendText">;
};

function readErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const envelope = data as VesicleErrorEnvelope;
    if (typeof envelope.message === "string" && envelope.message.trim()) {
      return envelope.code && envelope.code.trim()
        ? `${envelope.code}: ${envelope.message}`
        : envelope.message;
    }
  }
  return `HTTP ${status}`;
}

function readMessageId(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "unknown";
  }
  const response = data as VesicleMessageTextResponse;
  const messageGuid = response.message?.messageGuid;
  return typeof messageGuid === "string" && messageGuid.trim() ? messageGuid.trim() : "unknown";
}

export async function sendMessageVesicle(
  to: string,
  text: string,
  opts: VesicleSendOpts = {},
): Promise<VesicleSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg ?? {}, "Vesicle send");
  const account =
    opts.account ??
    resolveVesicleAccount({
      cfg,
      accountId: opts.accountId,
    });
  const target = parseVesicleTarget(to);
  if (target.kind !== "chat_guid") {
    throw new Error(
      "Vesicle send requires an existing chat target: use chat_guid:<GUID> until native chat lookup is available.",
    );
  }

  const stripped = stripInlineDirectiveTagsForDelivery(text ?? "").text;
  if (!stripped.trim()) {
    throw new Error("Vesicle send requires text");
  }

  const timeoutMs = opts.timeoutMs ?? account.config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const client =
    opts.client ??
    createVesicleClient({
      cfg,
      accountId: account.accountId,
      timeoutMs,
    });
  const { response, data } = await client.sendText({
    chatGuid: target.chatGuid,
    text: stripped,
    timeoutMs,
  });
  if (!response.ok) {
    throw new Error(
      `Vesicle send failed (${response.status}): ${readErrorMessage(data, response.status)}`,
    );
  }
  return {
    to: `chat_guid:${target.chatGuid}`,
    messageId: readMessageId(data),
  };
}
