/**
 * WhatsApp Lead Bot Plugin
 *
 * AI-powered lead qualification bot for WhatsApp with admin commands,
 * rate limiting, and follow-ups.
 */

import os from "node:os";
import path from "node:path";
import { AdminCommandHandler } from "./src/admin/commands.js";
import { WhatsAppLeadBotConfigSchema } from "./src/config/schema.js";
import { withContext } from "./src/context.js";
import { SqliteDatabase } from "./src/database/connection.js";
import { HandoffManager } from "./src/handoff/manager.js";
import { HandoffInterceptor } from "./src/hooks/handoff-interceptor.js";
import { MessageQueue } from "./src/hooks/message-queue.js";
import { createMessageReceivedHandler } from "./src/hooks/message-received.js";
import { createMessageSendingHandler } from "./src/hooks/message-sending.js";
import { createMessageSentHandler } from "./src/hooks/message-sent.js";
import { WhatsAppLabelService } from "./src/labels.js";
import { MediaHandler } from "./src/media/handler.js";
import { parseRawMessage } from "./src/messages/parse-raw.js";
import { AgentNotifier } from "./src/notifications/agent-notify.js";
import { CircuitBreaker } from "./src/rate-limit/circuit-breaker.js";
import { RateLimitCoordinator } from "./src/rate-limit/coordinator.js";
import { GlobalRateLimiter } from "./src/rate-limit/global-limiter.js";
import { RateLimiter } from "./src/rate-limit/limiter.js";
import type { Runtime } from "./src/runtime.js";
import { FileSessionResetter } from "./src/session-resetter/file-resetter.js";
import { blockLeadTool } from "./src/tools/block-lead.js";
import { calculateQuoteTool } from "./src/tools/calculate-quote.js";
import { downloadCFEReceiptTool } from "./src/tools/download-cfe-receipt.js";
import { getLeadTool } from "./src/tools/get-lead.js";
import { handoffLeadTool } from "./src/tools/handoff-lead.js";
import { addChatLabelTool, createLabelTool, getLabelsTool } from "./src/tools/label-ops.js";
import { listLeadsTool } from "./src/tools/list-leads.js";
import { parseCFEReceiptTool } from "./src/tools/parse-cfe-receipt.js";
import { saveLeadTool } from "./src/tools/save-lead.js";
import { saveReceiptDataTool } from "./src/tools/save-receipt-data.js";
import { syncLabelsTool } from "./src/tools/sync-labels.js";
const plugin = {
  id: "whatsapp-lead-bot",
  name: "WhatsApp Lead Bot",
  description:
    "AI-powered lead qualification bot for WhatsApp with admin commands, rate limiting, and follow-ups",
  configSchema: WhatsAppLeadBotConfigSchema,

  register(api: any) {
    const config = WhatsAppLeadBotConfigSchema.parse(api.pluginConfig);

    if (!config.enabled) {
      console.log("[whatsapp-lead-bot] Plugin disabled in config");
      return;
    }

    // Resolve database path
    const stateDir = api.runtime?.stateDir;
    if (!config.dbPath && !stateDir) {
      console.error(
        "[whatsapp-lead-bot] Neither config.dbPath nor api.runtime.stateDir is available",
      );
      return;
    }
    const dbPath = config.dbPath || path.join(stateDir, "whatsapp-lead-bot", "leads.db");

    // Initialize database (better-sqlite3 is synchronous)
    const db = new SqliteDatabase({ dbPath });
    db.migrate();
    console.log(`[whatsapp-lead-bot] Database initialized at ${dbPath}`);

    // Wire dependencies (DI composition root)
    const rateLimiter = new RateLimiter(db, config.rateLimit);

    // Create runtime adapter factory for sending messages from specific accounts
    const getRuntime = (accountId?: string): Runtime => {
      return {
        async sendMessage(
          to: string,
          content: { text: string; metadata?: Record<string, unknown> },
        ) {
          console.log(`[lead-bot] Sending message TO ${to} FROM accountId="${accountId}"`);

          // Use WhatsApp-specific API that supports accountId in options
          if (typeof (api.runtime as any).channel?.whatsapp?.sendMessageWhatsApp === "function") {
            await (api.runtime as any).channel.whatsapp.sendMessageWhatsApp(to, content.text, {
              verbose: false,
              accountId: accountId,
            });
          } else {
            console.warn(
              "[whatsapp-lead-bot] channel.whatsapp.sendMessageWhatsApp not available - message not sent",
            );
          }
        },
        async addChatLabel(chatJid: string, labelId: string) {
          try {
            if (
              typeof (api.runtime as any).channel?.whatsapp?.addChatLabelWhatsApp === "function"
            ) {
              await (api.runtime as any).channel.whatsapp.addChatLabelWhatsApp(chatJid, labelId, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] addChatLabel failed:", err);
          }
        },
        async removeChatLabel(chatJid: string, labelId: string) {
          try {
            if (
              typeof (api.runtime as any).channel?.whatsapp?.removeChatLabelWhatsApp === "function"
            ) {
              await (api.runtime as any).channel.whatsapp.removeChatLabelWhatsApp(
                chatJid,
                labelId,
                { accountId },
              );
            }
          } catch (err) {
            console.error("[lead-bot] removeChatLabel failed:", err);
          }
        },
        async getLabels() {
          try {
            if (typeof (api.runtime as any).channel?.whatsapp?.getLabelsWhatsApp === "function") {
              return await (api.runtime as any).channel.whatsapp.getLabelsWhatsApp({ accountId });
            }
          } catch (err) {
            console.error("[lead-bot] getLabels failed:", err);
          }
          return [];
        },
        async createLabel(name: string, color: number) {
          try {
            if (typeof (api.runtime as any).channel?.whatsapp?.createLabelWhatsApp === "function") {
              return await (api.runtime as any).channel.whatsapp.createLabelWhatsApp(name, color, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] createLabel failed:", err);
          }
          return undefined;
        },
        async addLabel(
          chatJid: string,
          labels: { id: string; name?: string; color?: number; deleted?: boolean },
        ) {
          try {
            if (typeof (api.runtime as any).channel?.whatsapp?.addLabelWhatsApp === "function") {
              await (api.runtime as any).channel.whatsapp.addLabelWhatsApp(chatJid, labels, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] addLabel failed:", err);
          }
        },
        async addMessageLabel(chatJid: string, messageId: string, labelId: string) {
          try {
            if (
              typeof (api.runtime as any).channel?.whatsapp?.addMessageLabelWhatsApp === "function"
            ) {
              await (api.runtime as any).channel.whatsapp.addMessageLabelWhatsApp(
                chatJid,
                messageId,
                labelId,
                { accountId },
              );
            }
          } catch (err) {
            console.error("[lead-bot] addMessageLabel failed:", err);
          }
        },
        async removeMessageLabel(chatJid: string, messageId: string, labelId: string) {
          try {
            if (
              typeof (api.runtime as any).channel?.whatsapp?.removeMessageLabelWhatsApp ===
              "function"
            ) {
              await (api.runtime as any).channel.whatsapp.removeMessageLabelWhatsApp(
                chatJid,
                messageId,
                labelId,
                { accountId },
              );
            }
          } catch (err) {
            console.error("[lead-bot] removeMessageLabel failed:", err);
          }
        },
        async onWhatsApp(...phoneNumbers: string[]) {
          try {
            if (typeof (api.runtime as any).channel?.whatsapp?.onWhatsApp === "function") {
              return await (api.runtime as any).channel.whatsapp.onWhatsApp(...phoneNumbers, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] onWhatsApp failed:", err);
          }
          return undefined;
        },
        async getBusinessProfile(jid: string) {
          try {
            if (
              typeof (api.runtime as any).channel?.whatsapp?.getBusinessProfileWhatsApp ===
              "function"
            ) {
              return await (api.runtime as any).channel.whatsapp.getBusinessProfileWhatsApp(jid, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] getBusinessProfile failed:", err);
          }
          return undefined;
        },
        async chatModify(mod: any, jid: string) {
          try {
            if (typeof (api.runtime as any).channel?.whatsapp?.chatModifyWhatsApp === "function") {
              await (api.runtime as any).channel.whatsapp.chatModifyWhatsApp(mod, jid, {
                accountId,
              });
            }
          } catch (err) {
            console.error("[lead-bot] chatModify failed:", err);
          }
        },
      };
    };

    // Default runtime for AgentNotifier (hook handlers get runtime via request context)
    const runtime = getRuntime(config.whatsappAccounts[0]);

    const agentNotifier = new AgentNotifier(runtime, config);
    const handoffManager = new HandoffManager(db, agentNotifier);

    // CFE receipt parsing — always active when API key is available
    // API key: config > env var (same key used by calculate_quote)
    const cfeApiKey = config.receiptExtraction?.apiKey || process.env.SUPABASE_API_KEY;
    if (!cfeApiKey) {
      console.warn("[whatsapp-lead-bot] No SUPABASE_API_KEY — CFE receipt parsing disabled");
    }
    const cfeParseContext = cfeApiKey
      ? {
          apiKey: cfeApiKey,
          apiUrl: config.supabaseCfeBillUrl,
          db,
          maxAttempts: config.receiptExtraction?.maxAttemptsPerLead ?? 3,
        }
      : undefined;
    const mediaHandler = new MediaHandler({ cfeParseContext });
    const handoffInterceptor = new HandoffInterceptor({ agentNotifier, cfeParseContext });

    // Wire 3-layer rate limiting
    const globalLimiter = new GlobalRateLimiter(db, config.rateLimit.global);
    const circuitBreaker = new CircuitBreaker(db, config.rateLimit.circuitBreaker, agentNotifier);
    const rateLimitCoordinator = new RateLimitCoordinator(
      circuitBreaker,
      globalLimiter,
      rateLimiter,
    );

    // Get self E.164 number for admin detection
    // This will need to be retrieved from OpenClaw's WhatsApp channel
    // For now, we'll pass null and admin detection will be disabled
    const selfE164: string | null = null; // TODO: Get from api.runtime or config

    // Wire session resetter for /reset-lead command
    const openclawStateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const agentId = config.agentId || config.whatsappAccounts[0] || "main";
    const sessionResetter = new FileSessionResetter(
      openclawStateDir,
      agentId,
      "whatsapp",
      config.whatsappAccounts[0] || "default",
    );

    const messageQueue = new MessageQueue();
    const labelService = new WhatsAppLabelService(config.labels, db);

    const adminHandler = new AdminCommandHandler(
      db,
      handoffManager,
      rateLimiter,
      selfE164,
      sessionResetter,
      circuitBreaker,
      globalLimiter,
      labelService,
    );

    // Register hooks wrapped with request context (accountId → runtime)
    api.on(
      "message_received",
      withContext(
        getRuntime,
        createMessageReceivedHandler,
      )({
        db,
        config,
        adminHandler,
        rateLimiter,
        rateLimitCoordinator,
        mediaHandler,
        agentNotifier,
        handoffManager,
        handoffInterceptor,
      }),
    );

    api.on(
      "message_sending",
      withContext(
        getRuntime,
        createMessageSendingHandler,
      )({
        db,
        config,
        handoffManager,
        messageQueue,
      }),
    );

    api.on("message_sent", withContext(getRuntime, createMessageSentHandler)({ messageQueue }));

    console.log("[whatsapp-lead-bot] Hooks registered");

    // Clean up DB on plugin unload
    if (typeof api.onUnload === "function") {
      api.onUnload(() => {
        db.close();
      });
    }

    // Helper: register a tool with standard JSON wrapping
    function registerPluginTool<TParams, TCtx>(
      label: string,
      tool: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        execute: (params: TParams, ctx: TCtx) => Promise<unknown>;
      },
      ctx: TCtx,
    ) {
      api.registerTool({
        name: tool.name,
        label,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_toolCallId: string, params: TParams) => {
          const result = await tool.execute(params, ctx);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      });
      console.log(`[whatsapp-lead-bot] Registered tool: ${tool.name}`);
    }

    // Register CFE receipt parsing tool (always on when API key exists)
    if (cfeParseContext) {
      registerPluginTool("Parse CFE Receipt", parseCFEReceiptTool, cfeParseContext);
    }

    // Register calculate_quote tool (uses SUPABASE_API_KEY env var)
    const supabaseApiKey = process.env.SUPABASE_API_KEY;
    if (supabaseApiKey) {
      registerPluginTool("Calculate Quote", calculateQuoteTool, {
        apiKey: supabaseApiKey,
        apiUrl: config.supabaseQuoteUrl,
      });
    }

    // Register CFE receipt download tool (no external deps, just wraps Python script)
    registerPluginTool("Download CFE Receipt", downloadCFEReceiptTool, {});

    // Register lead management tools
    registerPluginTool("Save Lead", saveLeadTool, { db, labelService, runtime });
    registerPluginTool("Get Lead", getLeadTool, { db });
    registerPluginTool("List Leads", listLeadsTool, { db });
    registerPluginTool("Handoff Lead", handoffLeadTool, { db, labelService, runtime });
    registerPluginTool("Block Lead", blockLeadTool, { db });
    registerPluginTool("Save Receipt Data", saveReceiptDataTool, { db });
    registerPluginTool("Sync Labels", syncLabelsTool, { db, labelService, runtime });
    registerPluginTool("Get Labels", getLabelsTool, { runtime });
    registerPluginTool("Create Label", createLabelTool, { runtime });
    registerPluginTool("Add Chat Label", addChatLabelTool, { runtime });

    console.log("[whatsapp-lead-bot] Plugin registered successfully");

    // Store ALL WhatsApp messages (inbound + outbound + bot replies) via raw Baileys events
    const onRawMsg = (api.runtime as any)?.channel?.whatsapp?.onRawWhatsAppMessage;
    if (typeof onRawMsg === "function") {
      const unsub = onRawMsg((acctId: string, rawMsg: unknown) => {
        if (config.whatsappAccounts.length > 0 && !config.whatsappAccounts.includes(acctId)) {
          return;
        }
        const stored = parseRawMessage(rawMsg as Parameters<typeof parseRawMessage>[0]);
        if (!stored) return;
        db.storeMessage(stored).catch((err) => {
          console.error("[lead-bot] Failed to store message:", err);
        });
      });

      if (typeof api.onUnload === "function") {
        api.onUnload(unsub);
      }
      console.log("[lead-bot] Raw WhatsApp message store registered");
    }
  },
};

export default plugin;
