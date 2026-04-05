import type { MullusiConfig } from "mullusi/plugin-sdk/core";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import type { BlueBubblesAccountConfig } from "./types.js";
export {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookPath,
  resolveWebhookPathFromConfig,
} from "./webhook-shared.js";

export type BlueBubblesRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type BlueBubblesMonitorOptions = {
  account: ResolvedBlueBubblesAccount;
  config: MullusiConfig;
  runtime: BlueBubblesRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookPath?: string;
};

export type BlueBubblesCoreRuntime = ReturnType<typeof getBlueBubblesRuntime>;

export type WebhookTarget = {
  account: ResolvedBlueBubblesAccount;
  config: MullusiConfig;
  runtime: BlueBubblesRuntimeEnv;
  core: BlueBubblesCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};
