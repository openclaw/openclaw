/**
 * Telegram GramJS channel plugin for openclaw.
 * 
 * Provides MTProto user account access (not bot API).
 * 
 * Phase 1: Authentication, session persistence, basic message send/receive
 * Phase 2: Media support
 * Phase 3: Secret Chats (E2E encryption)
 */

import type {
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";

// Import adapters from src/telegram-gramjs
import { configAdapter } from "../../../src/telegram-gramjs/config.js";
import { setupAdapter } from "../../../src/telegram-gramjs/setup.js";
import { gatewayAdapter, sendMessage } from "../../../src/telegram-gramjs/gateway.js";
import type { ResolvedGramJSAccount } from "../../../src/telegram-gramjs/types.js";

// Channel metadata
const meta = {
  id: "telegram-gramjs",
  label: "Telegram (User Account)",
  selectionLabel: "Telegram (GramJS User Account)",
  detailLabel: "Telegram User",
  docsPath: "/channels/telegram-gramjs",
  docsLabel: "telegram-gramjs",
  blurb: "user account via MTProto; access all chats including private groups.",
  systemImage: "paperplane.fill",
  aliases: ["gramjs", "telegram-user", "telegram-mtproto"],
  order: 1, // After regular telegram (0)
};

/**
 * Main channel plugin export.
 */
export const telegramGramJSPlugin: ChannelPlugin<ResolvedGramJSAccount> = {
  id: "telegram-gramjs",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },

  // ============================================
  // Capabilities
  // ============================================
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: false, // Phase 2
    nativeCommands: false, // User accounts don't have bot commands
    blockStreaming: false, // Not supported yet
  },

  // ============================================
  // Configuration
  // ============================================
  reload: { configPrefixes: ["channels.telegramGramjs", "telegramGramjs"] },
  config: configAdapter,
  setup: setupAdapter,
  
  // ============================================
  // Gateway (Message Polling & Connection)
  // ============================================
  gateway: gatewayAdapter,

  // ============================================
  // Security & Pairing
  // ============================================
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(telegram|tg):/i, ""),
    // TODO: Implement notifyApproval via GramJS sendMessage
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      const basePath = "telegramGramjs.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const groupPolicy = account.config.groupPolicy ?? "open";
      if (groupPolicy !== "open") return [];
      
      const groupAllowlistConfigured =
        account.config.groups && Object.keys(account.config.groups).length > 0;
      
      if (groupAllowlistConfigured) {
        return [
          `- Telegram GramJS groups: groupPolicy="open" allows any member in allowed groups to trigger. Set telegramGramjs.groupPolicy="allowlist" to restrict.`,
        ];
      }
      
      return [
        `- Telegram GramJS groups: groupPolicy="open" with no allowlist; any group can trigger. Configure telegramGramjs.groups or set groupPolicy="allowlist".`,
      ];
    },
  },

  // ============================================
  // Groups
  // ============================================
  groups: {
    resolveRequireMention: ({ cfg, groupId, account }) => {
      // Check group-specific config
      const groupConfig = account.config.groups?.[groupId];
      if (groupConfig?.requireMention !== undefined) {
        return groupConfig.requireMention;
      }
      
      // Fall back to account-level config
      return account.config.groupPolicy === "open" ? true : undefined;
    },
    
    resolveToolPolicy: ({ groupId, account }) => {
      const groupConfig = account.config.groups?.[groupId];
      return groupConfig?.tools;
    },
  },

  // ============================================
  // Threading
  // ============================================
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.telegramGramjs?.replyToMode ?? "first",
  },

  // ============================================
  // Messaging
  // ============================================
  messaging: {
    normalizeTarget: (target) => {
      // Support various formats:
      // - @username
      // - telegram:123456
      // - tg:@username
      // - plain chat_id: 123456
      if (!target) return null;
      
      const trimmed = target.trim();
      if (!trimmed) return null;
      
      // Remove protocol prefix
      const withoutProtocol = trimmed
        .replace(/^telegram:/i, "")
        .replace(/^tg:/i, "");
      
      return withoutProtocol;
    },
    targetResolver: {
      looksLikeId: (target) => {
        if (!target) return false;
        // Chat IDs are numeric or @username
        return /^-?\d+$/.test(target) || /^@[\w]+$/.test(target);
      },
      hint: "<chatId> or @username",
    },
  },

  // ============================================
  // Directory (optional)
  // ============================================
  directory: {
    self: async () => null, // TODO: Get current user info from GramJS
    listPeers: async () => [], // TODO: Implement via GramJS dialogs
    listGroups: async () => [], // TODO: Implement via GramJS dialogs
  },

  // ============================================
  // Outbound (Message Sending)
  // ============================================
  outbound: {
    deliveryMode: "gateway", // Use gateway for now; can switch to "direct" later
    
    chunker: (text, limit) => {
      // Simple text chunking (no markdown parsing yet)
      const chunks: string[] = [];
      let remaining = text;
      
      while (remaining.length > limit) {
        // Try to break at newline
        let splitIndex = remaining.lastIndexOf("\n", limit);
        if (splitIndex === -1 || splitIndex < limit / 2) {
          // No good newline, break at space
          splitIndex = remaining.lastIndexOf(" ", limit);
        }
        if (splitIndex === -1 || splitIndex < limit / 2) {
          // No good break point, hard split
          splitIndex = limit;
        }
        
        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex).trim();
      }
      
      if (remaining) {
        chunks.push(remaining);
      }
      
      return chunks;
    },
    
    chunkerMode: "text",
    textChunkLimit: 4000,
    
    sendText: async ({ to, text, replyToId, threadId, accountId }) => {
      const effectiveAccountId = accountId || "default";
      
      const result = await sendMessage(effectiveAccountId, {
        to,
        text,
        replyToId: replyToId || undefined,
        threadId: threadId ? String(threadId) : undefined,
      });
      
      if (!result.success) {
        throw new Error(result.error || "Failed to send message");
      }
      
      return {
        channel: "telegram-gramjs" as const,
        messageId: result.messageId || "unknown",
        chatId: to,
        timestamp: Date.now(),
      };
    },
    
    sendMedia: async ({ to, text, mediaUrl }) => {
      // Phase 2 - Not implemented yet
      throw new Error("GramJS sendMedia not yet implemented - Phase 2");
    },
  },

  // ============================================
  // Status
  // ============================================
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    
    collectStatusIssues: ({ account, cfg }) => {
      const issues: Array<{ severity: "error" | "warning"; message: string }> = [];
      
      // Check for API credentials
      if (!account.config.apiId || !account.config.apiHash) {
        issues.push({
          severity: "error",
          message: "Missing API credentials (apiId, apiHash). Get them from https://my.telegram.org/apps",
        });
      }
      
      // Check for session
      if (!account.config.sessionString && !account.config.sessionFile) {
        issues.push({
          severity: "error",
          message: "No session configured. Run 'openclaw setup telegram-gramjs' to authenticate.",
        });
      }
      
      // Check enabled state
      if (!account.enabled) {
        issues.push({
          severity: "warning",
          message: "Account is disabled. Set telegramGramjs.enabled = true to activate.",
        });
      }
      
      return issues;
    },
    
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      hasSession: snapshot.hasSession ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
  },
};
