/**
 * Gateway entry point — thin shell that passes the PluginRuntime to
 * core/gateway/gateway.ts.
 *
 * All module dependencies are imported directly by the core gateway.
 * This file only provides the runtime object (which is dynamically
 * injected by the framework at startup).
 */

import { createRequire } from "node:module";
import { resolveRuntimeServiceVersion } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  registerVersionResolver,
  registerPluginVersion,
} from "../engine/commands/slash-commands-impl.js";
import {
  startGateway as coreStartGateway,
  type CoreGatewayContext,
} from "../engine/gateway/gateway.js";
import type { GatewayAccount } from "../engine/gateway/types.js";
import { initSender } from "../engine/messaging/sender.js";
import { registerTextChunker } from "../engine/utils/text-chunk.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { setBridgeLogger } from "./logger.js";
import { getQQBotRuntimeForEngine } from "./runtime.js";

// Register framework SDK version resolver for core/ slash commands.
registerVersionResolver(resolveRuntimeServiceVersion);

// Inject plugin + framework versions into sender (avoids dynamic require inside engine/).
const _require = createRequire(import.meta.url);
let _pluginVersion = "unknown";
try {
  _pluginVersion = _require("../../package.json").version ?? "unknown";
} catch {
  /* fallback */
}
initSender({
  pluginVersion: _pluginVersion,
  openclawVersion: resolveRuntimeServiceVersion(),
});
registerPluginVersion(_pluginVersion);

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
  channelRuntime?: {
    runtimeContexts: {
      register: (params: {
        channelId: string;
        accountId: string;
        capability: string;
        context: unknown;
        abortSignal?: AbortSignal;
      }) => { dispose: () => void };
    };
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

  // Inject framework logger into engine sender and bridge-layer modules.
  if (ctx.log) {
    initSender({ logger: ctx.log });
    setBridgeLogger(ctx.log);
  }

  registerTextChunker((text, limit) => runtime.channel.text.chunkMarkdownText(text, limit));

  if (ctx.channelRuntime) {
    ctx.log?.info?.(`[qqbot:${ctx.account.accountId}] Registering approval.native runtime context`);
    const lease = ctx.channelRuntime.runtimeContexts.register({
      channelId: "qqbot",
      accountId: ctx.account.accountId,
      capability: "approval.native",
      context: { account: ctx.account },
      abortSignal: ctx.abortSignal,
    });
    ctx.log?.info?.(
      `[qqbot:${ctx.account.accountId}] approval.native context registered (lease=${!!lease})`,
    );
  } else {
    ctx.log?.info?.(
      `[qqbot:${ctx.account.accountId}] No channelRuntime — skipping approval.native registration`,
    );
  }

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
