import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { resolveDeltaChatAccount } from "./accounts.js";
import { rpcServerManager } from "./rpc-server.js";
import { getDeltaChatRuntime } from "./runtime.js";
import { parseDeltaChatTarget } from "./targets.js";
import type { CoreConfig } from "./types.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import { ensureDataDir } from "./utils.js";

export interface DeltaChatOutboundOptions {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
}

export async function sendDeltaChatMessage(
  options: DeltaChatOutboundOptions,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { cfg, to, text, accountId, replyToId } = options;
  const coreCfg = cfg as CoreConfig;

  // Resolve the account
  const account = resolveDeltaChatAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID });

  if (!account.configured) {
    return {
      ok: false,
      error: "Delta.Chat account is not configured",
    };
  }

  if (!account.enabled) {
    return {
      ok: false,
      error: "Delta.Chat account is disabled",
    };
  }

  const logger = getDeltaChatRuntime().logging.getChildLogger({ module: "deltachat-outbound" });
  try {
    const dataDir = coreCfg.channels?.deltachat?.dataDir ?? DEFAULT_DATA_DIR;
    const expandedDataDir = ensureDataDir(dataDir);
    const dc = await rpcServerManager.start(expandedDataDir);
    if (!dc) {
      return {
        ok: false,
        error: "Failed to start Delta.Chat RPC server",
      };
    }

    // Get or create account
    let accounts = await dc.rpc.getAllAccounts();
    let dcAccount = accounts[0];

    if (!dcAccount) {
      const accountId = await dc.rpc.addAccount();
      dcAccount = await dc.rpc.getAccountInfo(accountId);
    }

    // Start IO if not already started
    if (dcAccount.kind === "Configured") {
      await dc.rpc.startIo(dcAccount.id);
    }

    // Parse the target to determine if it's an email or chat ID
    logger.info(`[Delta.Chat] sendDeltaChatMessage called with to="${to}"`);
    const parsed = parseDeltaChatTarget(to);
    logger.info(`[Delta.Chat] Parsed target: kind="${parsed.kind}", to="${parsed.to}"`);
    let targetChatId: number | undefined;

    if (parsed.kind === "chat_id") {
      // Use the chat ID directly
      targetChatId = parseInt(parsed.to, 10);
      logger.info(`[Delta.Chat] Using chatId directly: ${targetChatId}`);
    } else {
      // It's an email address, create or get the chat
      logger.info(`[Delta.Chat] Creating chat for email: ${parsed.to}`);
      try {
        const contactId = await dc.rpc.createContact(dcAccount.id, parsed.to, parsed.to);
        targetChatId = await dc.rpc.createChatByContactId(dcAccount.id, contactId);
        logger.info(`[Delta.Chat] Created chat with ID: ${targetChatId}`);
      } catch (err) {
        return {
          ok: false,
          error: `Failed to create chat with ${parsed.to}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Send the message using miscSendTextMessage
    logger.info(`[Delta.Chat] Sending message to chatId ${targetChatId}`);
    const messageId = await dc.rpc.miscSendTextMessage(dcAccount.id, targetChatId, text);

    logger.info(`[Delta.Chat] Sent message ${messageId} to ${to} (chatId: ${targetChatId})`);

    return {
      ok: true,
      messageId: String(messageId),
    };
  } catch (err) {
    logger.error(
      `[Delta.Chat] Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
