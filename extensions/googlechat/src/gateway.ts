import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
  type OpenClawConfig,
  type ResolvedGoogleChatAccount,
} from "./channel.deps.runtime.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

export async function startGoogleChatGatewayAccount(ctx: {
  account: ResolvedGoogleChatAccount;
  cfg: OpenClawConfig;
  runtime: unknown;
  abortSignal: AbortSignal;
  setStatus: (patch: Record<string, unknown>) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: account.accountId,
    setStatus: ctx.setStatus,
  });
  ctx.log?.info?.(`[${account.accountId}] starting Google Chat webhook`);
  const { resolveGoogleChatWebhookPath, startGoogleChatMonitor } =
    await loadGoogleChatChannelRuntime();
  statusSink({
    running: true,
    lastStartAt: Date.now(),
    webhookPath: resolveGoogleChatWebhookPath({ account }),
    audienceType: account.config.audienceType,
    audience: account.config.audience,
  });
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await startGoogleChatMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        statusSink,
      }),
    stop: async (unregister) => {
      unregister?.();
    },
    onStop: async () => {
      statusSink({
        running: false,
        lastStopAt: Date.now(),
      });
    },
  });
}
