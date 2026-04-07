/**
 * Missed-Call-to-SMS — runtime composer.
 *
 * Wires together: config → store → Telnyx voice webhook handler →
 * Deepgram transcription → Claude agent → Telnyx SMS. Exposes a narrow
 * interface to the plugin entry point in index.ts.
 *
 * Stage 1 scaffold: starts the webhook server, loads the store, logs
 * startup state. Stages 2-3 fill in the behavior.
 */

import { AgentEngine } from "./agent.js";
import type { MissedCallSmsConfig } from "./config.js";
import { MissedCallSmsStore } from "./store.js";
import { TelnyxCallsClient } from "./telnyx-calls.js";
import { TelnyxMessagingClient } from "./telnyx-sms.js";
import { startWebhookServer, type WebhookServer } from "./webhook.js";

export interface RuntimeLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface MissedCallSmsRuntime {
  config: MissedCallSmsConfig;
  store: MissedCallSmsStore;
  agent: AgentEngine;
  telnyxCalls: TelnyxCallsClient;
  telnyxSms: TelnyxMessagingClient;
  sendManualReply(
    conversationId: string,
    message: string,
  ): Promise<{ success: boolean; error?: string }>;
  stop(): Promise<void>;
}

export interface CreateRuntimeOptions {
  config: MissedCallSmsConfig;
  logger: RuntimeLogger;
}

export async function createMissedCallSmsRuntime(
  opts: CreateRuntimeOptions,
): Promise<MissedCallSmsRuntime> {
  const { config, logger } = opts;

  const store = new MissedCallSmsStore(config.store.path);
  await store.init();

  const telnyxCalls = new TelnyxCallsClient({
    apiKey: config.telnyx.apiKey!,
    logger,
  });

  const telnyxSms = new TelnyxMessagingClient({
    apiKey: config.telnyx.apiKey!,
    messagingProfileId: config.telnyx.messagingProfileId!,
    fromNumber: config.telnyx.fromNumber!,
    logger,
  });

  const agent = new AgentEngine({
    config,
    store,
    telnyxSms,
    logger,
  });

  let webhookServer: WebhookServer | null = null;
  webhookServer = await startWebhookServer({
    config,
    store,
    telnyxCalls,
    telnyxSms,
    agent,
    logger,
  });

  const sendManualReply = async (
    conversationId: string,
    message: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const convo = await store.getConversation(conversationId);
    if (!convo) return { success: false, error: "conversation not found" };
    try {
      const result = await telnyxSms.send({
        to: convo.callerPhone,
        text: message,
      });
      await store.appendMessage(conversationId, {
        role: "human-owner",
        content: message,
        providerMessageId: result.messageId,
      });
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[missed-call-sms] manual reply failed: ${msg}`);
      return { success: false, error: msg };
    }
  };

  return {
    config,
    store,
    agent,
    telnyxCalls,
    telnyxSms,
    sendManualReply,
    stop: async () => {
      if (webhookServer) {
        await webhookServer.stop();
        webhookServer = null;
      }
    },
  };
}
