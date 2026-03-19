import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";
import { PAIRING_APPROVED_MESSAGE, resolveChannelMediaMaxBytes } from "../runtime-api.js";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { monitorIMessageProvider } from "./monitor.js";
import { probeIMessage } from "./probe.js";
import { getIMessageRuntime } from "./runtime.js";
import { imessageSetupWizard } from "./setup-surface.js";

type IMessageSendFn = ReturnType<
  typeof getIMessageRuntime
>["channel"]["imessage"]["sendMessageIMessage"];

export async function sendIMessageOutbound(params: {
  cfg: Parameters<typeof import("./accounts.js").resolveIMessageAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string;
}) {
  const send =
    resolveOutboundSendDep<IMessageSendFn>(params.deps, "imessage") ??
    getIMessageRuntime().channel.imessage.sendMessageIMessage;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.imessage?.mediaMaxMb,
    accountId: params.accountId,
  });
  return await send(params.to, params.text, {
    config: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
  });
}

export async function notifyIMessageApproval(id: string): Promise<void> {
  await getIMessageRuntime().channel.imessage.sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
}

export async function probeIMessageAccount(timeoutMs?: number) {
  return await probeIMessage(timeoutMs);
}

export async function startIMessageGatewayAccount(
  ctx: Parameters<
    NonNullable<
      NonNullable<
        import("../runtime-api.js").ChannelPlugin<ResolvedIMessageAccount>["gateway"]
      >["startAccount"]
    >
  >[0],
) {
  const account = ctx.account;
  const cliPath = account.config.cliPath?.trim() || "imsg";
  const dbPath = account.config.dbPath?.trim();
  ctx.setStatus({
    accountId: account.accountId,
    cliPath,
    dbPath: dbPath ?? null,
  });
  ctx.log?.info?.(
    `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
  );
  return await monitorIMessageProvider({
    accountId: account.accountId,
    config: ctx.cfg,
    runtime: ctx.runtime,
    abortSignal: ctx.abortSignal,
  });
}

export { imessageSetupWizard };
