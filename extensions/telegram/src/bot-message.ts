// Telegram plugin module implements bot message behavior.
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { appendJinheeConversationLog } from "../../../src/agents/jinhee-conversation-log-writer.js";
import type { PluginActionDescriptor } from "../../../src/plugins/plugin-adapter.types.js";
import { guardPluginActionsRuntime } from "../../../src/plugins/plugin-runtime-guard.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import {
  TELEGRAM_FULL_MCP_TRIGGERS,
  TELEGRAM_MCP_PLUGIN_MANIFESTS,
} from "./mcp-plugin-manifest.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";
import { buildTelegramPluginStatusMessage, isPluginCommand } from "./plugin-status-message.js";

async function fetchMemoryContext(query: string): Promise<string | null> {
  try {
    const response = await fetch("http://localhost:5050/api/memory/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { context: string; count: number };
    if (!data.context) return null;
    telegramInboundLog.info(`memory_count: ${data.count}`);
    return data.context;
  } catch (err) {
    logVerbose(`failed to fetch memory context: ${String(err)}`);
    return null;
  }
}

const telegramInboundLog = createSubsystemLogger("gateway/channels/telegram").child("inbound");

function appendTelegramInboundJinheeLog(params: {
  chatId: number | string;
  text: string;
  messageId?: number | string;
}): void {
  void appendJinheeConversationLog(
    {
      sessionId: String(params.chatId),
      role: "user",
      content: params.text,
      source: "telegram_openclaw",
      messageId: params.messageId != null ? String(params.messageId) : undefined,
    },
    { allowOperationalDb: true },
  )
    .then((result) => {
      if (!result.ok) {
        console.warn(`jinhee inbound conversation log skipped: ${result.reason}`);
      }
    })
    .catch((error: unknown) => {
      console.warn(`jinhee inbound conversation log failed: ${String(error)}`);
    });
}

function isAsciiTokenTrigger(trigger: string): boolean {
  return /^[a-z0-9_-]+(?:\s+[a-z0-9_-]+)*$/u.test(trigger);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTelegramMcpTrigger(text: string, trigger: string): boolean {
  const normalizedTrigger = trigger.toLocaleLowerCase();
  if (!isAsciiTokenTrigger(normalizedTrigger)) {
    return text.includes(normalizedTrigger);
  }
  const escaped = escapeRegExp(normalizedTrigger).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, "u").test(text);
}

export function selectTelegramMcpServersFromText(text: string): readonly string[] {
  const normalized = text.toLocaleLowerCase();
  if (
    TELEGRAM_FULL_MCP_TRIGGERS.some((trigger) => matchesTelegramMcpTrigger(normalized, trigger))
  ) {
    return ["*"];
  }
  return TELEGRAM_MCP_PLUGIN_MANIFESTS.flatMap((manifest) =>
    manifest.triggers.some((trigger) => matchesTelegramMcpTrigger(normalized, trigger))
      ? [manifest.serverName]
      : [],
  );
}

export function formatTelegramInboundLogLine(params: {
  from: string;
  to: string;
  chatType: string;
  body: string;
  mediaType?: string;
}): string {
  const kindLabel = params.mediaType ? `, ${params.mediaType}` : "";
  return `Inbound message ${params.from} -> ${params.to} (${params.chatType}${kindLabel}, ${params.body.length} chars)`;
}

type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramDeps: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token">;
};

export type TelegramMessageProcessorLifecycle = {
  onDispatchStart?: () => Promise<void> | void;
};

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    telegramDeps,
    opts,
  } = deps;
  const sessionRuntime = {
    ...(telegramDeps.buildChannelInboundEventContext
      ? { buildChannelInboundEventContext: telegramDeps.buildChannelInboundEventContext }
      : {}),
    ...(telegramDeps.readSessionUpdatedAt
      ? { readSessionUpdatedAt: telegramDeps.readSessionUpdatedAt }
      : {}),
    ...(telegramDeps.recordInboundSession
      ? { recordInboundSession: telegramDeps.recordInboundSession }
      : {}),
    ...(telegramDeps.resolveInboundLastRouteSessionKey
      ? { resolveInboundLastRouteSessionKey: telegramDeps.resolveInboundLastRouteSessionKey }
      : {}),
    ...(telegramDeps.resolvePinnedMainDmOwnerFromAllowlist
      ? {
          resolvePinnedMainDmOwnerFromAllowlist: telegramDeps.resolvePinnedMainDmOwnerFromAllowlist,
        }
      : {}),
    resolveStorePath: telegramDeps.resolveStorePath,
  };
  const contextRuntime = telegramDeps.recordChannelActivity
    ? { recordChannelActivity: telegramDeps.recordChannelActivity }
    : undefined;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
    replyChain?: TelegramReplyChainEntry[],
    promptContext?: TelegramPromptContextEntry[],
    lifecycle?: TelegramMessageProcessorLifecycle,
  ) => {
    const ingressReceivedAtMs =
      typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs)
        ? options.receivedAtMs
        : undefined;
    const ingressDebugEnabled =
      shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
    const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : undefined;


    // TICKET-030: Memory Context Integration
    const query = primaryCtx.message.text || "";

    // OC-MCP-STATUS-ALIAS-001: Intercept /mcp_status, /mcp_plugins, /plugin_status — no MCP, no dispatch
    if (isPluginCommand(query)) {
      const statusMessage = buildTelegramPluginStatusMessage();
      try {
        await bot.api.sendMessage(primaryCtx.message.chat.id, statusMessage, {
          parse_mode: "MarkdownV2",
        });
      } catch {
        // silently ignore send failures for status commands
      }
      return true;
    }

    if (query) {
      appendTelegramInboundJinheeLog({
        chatId: primaryCtx.message.chat.id,
        text: query,
        messageId: primaryCtx.message.message_id,
      });
    }

    const selectedMcpServers = selectTelegramMcpServersFromText(query);

    // PLUGIN-RUNTIME-002 / BLOCK-003: Pre-filter at MCP server selection level.
    // Conservative pre-filter (always "read" capability — tool-level enforcement
    // happens at callTool chokepoint in agent-bundle-mcp-materialize.ts).
    if (selectedMcpServers.length > 0) {
      const guardDescriptor: PluginActionDescriptor = {
        id: "telegram-mcp",
        name: "mcp-tool-execution",
        description: `Selected MCP servers: ${selectedMcpServers.join(", ")}`,
        capabilities: ["read"],
      };
      const guardDecision = guardPluginActionsRuntime([guardDescriptor]);
      if (!guardDecision.ok) {
        telegramInboundLog.info(
          `[PLUGIN-RUNTIME-BLOCK-003] MCP pre-filter: ${guardDecision.reason}`,
        );
      }
    }
    const activePromptContext = promptContext || [];
    if (query && query.length > 2) {
      const memoryContext = await fetchMemoryContext(query);
      if (memoryContext) {
        activePromptContext.push({
          label: "Relevant Memories",
          source: "memory_engine",
          type: "text",
          payload: { text: `=== RELEVANT MEMORIES ===\n${memoryContext}\n=== END MEMORIES ===` },
        });
      }
    }

=======
    const recordCurrentUpdateProcessingResult = (result: TelegramMessageProcessingResult) => {
      if (options?.spooledReplay === true) {
        return;
      }
      recordTelegramMessageProcessingResult(result);
    };
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      replyChain,
      promptContext: activePromptContext,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
      loadFreshConfig,
      runtime: contextRuntime,
      sessionRuntime,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
        logVerbose(
          `telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      const result: TelegramMessageProcessingResult = { kind: "skipped" };
      recordCurrentUpdateProcessingResult(result);
      return result;
    }
    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
      );
    }
    if (
      context.ctxPayload.InboundEventKind !== "room_event" &&
      context.initialTypingCueSent !== true
    ) {
      void context.sendTyping().catch((err: unknown) => {
        logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
      });
    }
    telegramInboundLog.info(
      formatTelegramInboundLogLine({
        from: context.ctxPayload.From,
        to: context.primaryCtx.me?.username
          ? `@${context.primaryCtx.me.username}`
          : context.ctxPayload.To,
        chatType: context.ctxPayload.ChatType,
        body: context.ctxPayload.RawBody,
        mediaType: allMedia[0]?.contentType,
      }),
    );
    await lifecycle?.onDispatchStart?.();
    const spooledReplay =
      options?.spooledReplay === true || isTelegramSpooledReplayUpdate(primaryCtx.update);
    try {
      const dispatchResult = await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        telegramDeps,
        opts,
        selectedMcpServers,
        retryDispatchErrors: spooledReplay,
        suppressFailureFallback: spooledReplay,
      });
      if (dispatchResult?.kind === "failed-retryable") {
        const result: TelegramMessageProcessingResult = {
          kind: "failed-retryable",
          error: dispatchResult.error,
        };
        recordCurrentUpdateProcessingResult(result);
        return result;
      }
      if (ingressDebugEnabled && ingressReceivedAtMs) {
        logVerbose(
          `telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      const result: TelegramMessageProcessingResult = { kind: "completed" };
      recordCurrentUpdateProcessingResult(result);
      return result;
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      if (!spooledReplay) {
        try {
          await bot.api.sendMessage(
            context.chatId,
            "Something went wrong while processing your request. Please try again.",
            buildTelegramThreadParams(context.threadSpec),
          );
        } catch {}
      }
      const result: TelegramMessageProcessingResult = {
        kind: "failed-retryable",
        error: err,
      };
      recordCurrentUpdateProcessingResult(result);
      return result;
    }
  };
};
