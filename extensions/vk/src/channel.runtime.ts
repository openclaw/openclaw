import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { resolveVkAccount } from "./accounts.js";
import { probeVkAccount } from "./probe.js";
import { getVkRuntime } from "./runtime.js";
import { sendVkText } from "./send.js";
import type { ResolvedVkAccount } from "./types.js";

export async function notifyVkPairingApproval(params: {
  cfg: import("openclaw/plugin-sdk/core").OpenClawConfig;
  id: string;
}) {
  const account = resolveVkAccount({ cfg: params.cfg });
  if (!account.token) {
    throw new Error("VK token not configured");
  }
  await sendVkText(params.id, "OpenClaw: your access has been approved.", {
    token: account.token,
  });
}

export async function sendVkTextFromRuntime(
  params: Parameters<typeof sendVkText>[2] & {
    to: string;
    text: string;
  },
) {
  return await sendVkText(params.to, params.text, params);
}

export async function startVkGatewayAccount(
  ctx: Parameters<
    NonNullable<
      NonNullable<import("openclaw/plugin-sdk/core").ChannelPlugin["gateway"]>["startAccount"]
    >
  >[0],
) {
  const account = ctx.account as ResolvedVkAccount;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  const probe = await probeVkAccount({ account, timeoutMs: 2500 });
  if (probe.ok) {
    statusSink({
      tokenSource: account.tokenSource,
      connected: true,
      lastConnectedAt: Date.now(),
      profile: probe.group,
      lastError: null,
    });
  } else {
    statusSink({
      tokenSource: account.tokenSource,
      connected: false,
      lastError: probe.error,
    });
  }
  ctx.log?.info(
    `[${account.accountId}] starting provider${probe.ok && probe.group.name ? ` (${probe.group.name})` : ""}`,
  );
  const { monitorVkProvider } = await import("./monitor.js");
  return await monitorVkProvider({
    account,
    config: ctx.cfg,
    token: account.token,
    runtime: getVkRuntime(),
    abortSignal: ctx.abortSignal,
    statusSink,
    log: ctx.log,
  });
}
