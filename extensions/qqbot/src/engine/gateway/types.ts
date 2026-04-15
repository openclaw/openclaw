/**
 * Gateway types.
 *
 * core/gateway/gateway.ts now imports all dependencies directly (both
 * core/ modules and upper-layer files). The only injected dependency
 * is `runtime` (PluginRuntime), which is a framework-provided object.
 */

// ============ Logger ============

export interface GatewayLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

// ============ Account ============

/** Resolved account configuration — subset used by the gateway. */
export interface GatewayAccount {
  accountId: string;
  appId: string;
  clientSecret: string;
  markdownSupport: boolean;
  systemPrompt?: string;
  config: Record<string, unknown> & {
    allowFrom?: unknown[];
    streaming?: { mode?: string };
    audioFormatPolicy?: {
      uploadDirectFormats?: string[];
      transcodeEnabled?: boolean;
    };
    voiceDirectUploadFormats?: string[];
  };
}

// ============ PluginRuntime subset ============

/**
 * Subset of PluginRuntime used by the gateway.
 *
 * This is NOT a custom adapter — it's the exact same object shape that
 * the framework injects. We define it here so core/ doesn't need to
 * `import from "openclaw/plugin-sdk"`.
 */
export interface GatewayPluginRuntime {
  channel: {
    activity: {
      record: (params: {
        channel: string;
        accountId: string;
        direction: "inbound" | "outbound";
      }) => void;
    };
    routing: {
      resolveAgentRoute: (params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "group" | "direct"; id: string };
      }) => { sessionKey: string; accountId: string; agentId?: string };
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: (params: unknown) => Promise<unknown>;
      resolveEffectiveMessagesConfig: (
        cfg: unknown,
        agentId?: string,
      ) => { responsePrefix?: string };
      finalizeInboundContext: (fields: Record<string, unknown>) => unknown;
      formatInboundEnvelope: (params: unknown) => string;
      resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
    };
    text: {
      chunkMarkdownText: (text: string, limit: number) => string[];
    };
  };
  tts: {
    textToSpeech: (params: { text: string; cfg: unknown; channel: string }) => Promise<{
      success: boolean;
      audioPath?: string;
      provider?: string;
      outputFormat?: string;
      error?: string;
    }>;
  };
}

// ============ Shared result types ============

/** Processed attachment result from inbound-attachments. */
export interface ProcessedAttachments {
  attachmentInfo: string;
  imageUrls: string[];
  imageMediaTypes: string[];
  voiceAttachmentPaths: string[];
  voiceAttachmentUrls: string[];
  voiceAsrReferTexts: string[];
  voiceTranscripts: string[];
  voiceTranscriptSources: string[];
  attachmentLocalPaths: Array<string | null>;
}

/** Outbound result from media sends. */
export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

/** Re-export RefAttachmentSummary for convenience. */
export type { RefAttachmentSummary } from "../ref/types.js";

// ============ Gateway Context ============

/** Full gateway startup context. Only `runtime` is injected; everything else is imported directly. */
export interface CoreGatewayContext {
  account: GatewayAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: GatewayLogger;
  /** PluginRuntime injected by the framework — same object in both versions. */
  runtime: GatewayPluginRuntime;
}
