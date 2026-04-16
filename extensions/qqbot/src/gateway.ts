/**
 * Gateway entry point — thin shell that passes the PluginRuntime to
 * core/gateway/gateway.ts.
 *
 * All module dependencies are imported directly by the core gateway.
 * This file only provides the runtime object (which is dynamically
 * injected by the framework at startup).
 */

import { resolveRuntimeServiceVersion } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  startGateway as coreStartGateway,
  type CoreGatewayContext,
} from "./engine/gateway/gateway.js";
import { registerVersionResolver } from "./engine/gateway/slash-commands-impl.js";
import type { GatewayAccount } from "./engine/gateway/types.js";
import { registerTextChunker } from "./engine/utils/text-chunk.js";
import { getQQBotRuntimeForEngine } from "./runtime.js";
import type { ResolvedQQBotAccount } from "./types.js";

// Register framework SDK version resolver for core/ slash commands.
registerVersionResolver(resolveRuntimeServiceVersion);

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * Start the Gateway WebSocket connection.
 *
 * Passes the PluginRuntime to core/gateway/gateway.ts.
 * All other dependencies are imported directly by the core module.
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const runtime = getQQBotRuntimeForEngine();

  registerTextChunker((text, limit) => runtime.channel.text.chunkMarkdownText(text, limit));

  const coreCtx: CoreGatewayContext = {
    account: ctx.account as unknown as GatewayAccount,
    abortSignal: ctx.abortSignal,
    cfg: ctx.cfg,
    onReady: ctx.onReady,
    onError: ctx.onError,
    log: ctx.log,
    runtime,
  };

  return coreStartGateway(coreCtx);
}
