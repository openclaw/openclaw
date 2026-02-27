import { normalizeWebhookPath, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import type { BlueBubblesAccountConfig } from "./types.js";

export { normalizeWebhookPath };

export type BlueBubblesRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type BlueBubblesMonitorOptions = {
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookPath?: string;
};

export type BlueBubblesCoreRuntime = ReturnType<typeof getBlueBubblesRuntime>;

export type WebhookTarget = {
  account: ResolvedBlueBubblesAccount;
  config: OpenClawConfig;
  runtime: BlueBubblesRuntimeEnv;
  core: BlueBubblesCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export const DEFAULT_WEBHOOK_PATH = "/bluebubbles-webhook";

export function resolveWebhookPathFromConfig(config?: BlueBubblesAccountConfig): string {
  const raw = config?.webhookPath?.trim();
  if (raw) {
    return normalizeWebhookPath(raw);
  }
  return DEFAULT_WEBHOOK_PATH;
}
