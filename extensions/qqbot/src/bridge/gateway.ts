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
  registerVersionResolver,
  registerPluginVersion,
  registerApproveRuntimeGetter,
} from "../engine/commands/slash-commands-impl.js";
import {
  startGateway as coreStartGateway,
  type CoreGatewayContext,
} from "../engine/gateway/gateway.js";
import type { GatewayAccount } from "../engine/gateway/types.js";
import { initSender, registerAccount } from "../engine/messaging/sender.js";
import type { EngineLogger } from "../engine/types.js";
import { debugLog, debugError } from "../engine/utils/log.js";
import { registerTextChunker } from "../engine/utils/text-chunk.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { setBridgeLogger } from "./logger.js";
import { resolveQQBotPluginVersion } from "./plugin-version.js";
import { getQQBotRuntimeForEngine } from "./runtime.js";

// Register framework SDK version resolver for core/ slash commands.
registerVersionResolver(resolveRuntimeServiceVersion);

// Inject plugin + framework versions into sender and into the slash
// command registry. The plugin version is read from this plugin's own
// `package.json` by walking up from this file's URL, which is robust
// against source-vs-dist layout differences.
const _pluginVersion = resolveQQBotPluginVersion(import.meta.url);
initSender({
  pluginVersion: _pluginVersion,
  openclawVersion: resolveRuntimeServiceVersion(),
});
registerPluginVersion(_pluginVersion);

// Register runtime getter for /bot-approve config management.
registerApproveRuntimeGetter(() => {
  const rt = getQQBotRuntimeForEngine();
  return {
    config: rt.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    },
  };
});

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
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

  // Create per-account logger with auto [qqbot:{accountId}] prefix.
  const accountLogger = createAccountLogger(ctx.log, ctx.account.accountId);

  // Register into engine sender (per-appId logger + API config) and bridge layer.
  registerAccount(ctx.account.appId, {
    logger: accountLogger,
    markdownSupport: ctx.account.markdownSupport,
  });
  setBridgeLogger(accountLogger);

  registerTextChunker((text, limit) => runtime.channel.text.chunkMarkdownText(text, limit));

  if (ctx.channelRuntime) {
    accountLogger.info("Registering approval.native runtime context");
    const lease = ctx.channelRuntime.runtimeContexts.register({
      channelId: "qqbot",
      accountId: ctx.account.accountId,
      capability: "approval.native",
      context: { account: ctx.account },
      abortSignal: ctx.abortSignal,
    });
    accountLogger.info(`approval.native context registered (lease=${!!lease})`);
  } else {
    accountLogger.info("No channelRuntime — skipping approval.native registration");
  }

  const coreCtx: CoreGatewayContext = {
    account: ctx.account as unknown as GatewayAccount,
    abortSignal: ctx.abortSignal,
    cfg: ctx.cfg,
    onReady: ctx.onReady,
    onResumed: ctx.onResumed,
    onError: ctx.onError,
    log: accountLogger,
    runtime,
  };

  return coreStartGateway(coreCtx);
}

// ============ Per-account logger factory ============

/**
 * Create an EngineLogger that auto-prefixes all messages with `[qqbot:{accountId}]`.
 *
 * Follows the WhatsApp pattern of per-connection loggers — each account gets
 * its own logger instance so multi-account logs are automatically attributed.
 */
function createAccountLogger(
  raw: GatewayContext["log"] | undefined,
  accountId: string,
): EngineLogger {
  const prefix = `[${accountId}]`;
  if (!raw) {
    return {
      info: (msg) => debugLog(`${prefix} ${msg}`),
      error: (msg) => debugError(`${prefix} ${msg}`),
      warn: (msg) => debugError(`${prefix} ${msg}`),
      debug: (msg) => debugLog(`${prefix} ${msg}`),
    };
  }
  return {
    info: (msg) => raw.info(`${prefix} ${msg}`),
    error: (msg) => raw.error(`${prefix} ${msg}`),
    warn: (msg) => raw.error(`${prefix} ${msg}`),
    debug: (msg) => raw.debug?.(`${prefix} ${msg}`),
  };
}
