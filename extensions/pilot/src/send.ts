import { resolvePilotAccount } from "./accounts.js";
import { normalizePilotTarget } from "./normalize.js";
import * as pilotctl from "./pilotctl.js";
import { getPilotRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendPilotOptions = {
  cfg?: CoreConfig;
  accountId?: string;
  replyTo?: string;
};

export type SendPilotResult = {
  messageId: string;
  target: string;
};

export async function sendPilotMessage(
  to: string,
  text: string,
  opts: SendPilotOptions = {},
): Promise<SendPilotResult> {
  const runtime = getPilotRuntime();
  const cfg = (opts.cfg ?? runtime.config.loadConfig()) as CoreConfig;
  const account = resolvePilotAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `Pilot is not configured for account "${account.accountId}" (need hostname in channels.pilot).`,
    );
  }

  const target = normalizePilotTarget(to);
  if (!target) {
    throw new Error(`Invalid Pilot target: ${to}`);
  }

  const tableMode = runtime.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "pilot",
    accountId: account.accountId,
  });
  const prepared = runtime.channel.text.convertMarkdownTables(text.trim(), tableMode);
  const payload = opts.replyTo ? `${prepared}\n\n[reply:${opts.replyTo}]` : prepared;

  if (!payload.trim()) {
    throw new Error("Message must be non-empty for Pilot sends");
  }

  const result = await pilotctl.sendMessage(target, payload, {
    socketPath: account.socketPath,
    pilotctlPath: account.pilotctlPath,
  });

  runtime.channel.activity.record({
    channel: "pilot",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.messageId,
    target,
  };
}
