import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import type { ResolvedVesicleAccount } from "./accounts.js";
import {
  registerVesicleWebhookTarget,
  resolveConfiguredVesicleWebhookSecret,
  resolveVesicleWebhookPath,
} from "./webhook.js";

type VesicleGatewayStart = NonNullable<
  NonNullable<ChannelPlugin<ResolvedVesicleAccount>["gateway"]>["startAccount"]
>;

export const startVesicleGatewayAccount: VesicleGatewayStart = async (ctx) => {
  const secret = resolveConfiguredVesicleWebhookSecret(ctx.account);
  if (!secret) {
    ctx.log?.info?.(
      `[${ctx.account.accountId}] Vesicle native webhook disabled (webhookSecret not configured)`,
    );
    return;
  }

  const path = resolveVesicleWebhookPath(ctx.account);
  const statusSink = createAccountStatusSink({
    accountId: ctx.account.accountId,
    setStatus: ctx.setStatus,
  });
  statusSink({
    baseUrl: ctx.account.baseUrl,
    webhookPath: path,
  });
  ctx.log?.info?.(`[${ctx.account.accountId}] Vesicle webhook listening on ${path}`);

  const unregister = registerVesicleWebhookTarget({
    account: ctx.account,
    config: ctx.cfg,
    runtime: ctx.runtime,
    path,
    secret,
    statusSink,
  });

  await new Promise<void>((resolve) => {
    const stop = () => {
      unregister();
      resolve();
    };
    if (ctx.abortSignal.aborted) {
      stop();
      return;
    }
    ctx.abortSignal.addEventListener("abort", stop, { once: true });
  });
};
