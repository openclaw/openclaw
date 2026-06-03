import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

/**
 * Full-context capture log.
 *
 * Unlike `anthropic-payload-log.ts` (Anthropic-only, request/usage only), this
 * captures the COMPLETE per-call context for ALL providers and writes one JSONL
 * line per model call into the agent's working folder:
 *
 *   - request:  the literal wire payload sent to the provider, including the
 *               assembled system prompt, the full message history, and the tool
 *               definitions (via the transport `onPayload` callback). Falls back
 *               to the in-memory `context` (system + messages) if a transport
 *               does not surface `onPayload`.
 *   - response: the full assistant message returned by the provider, including
 *               text, thinking / redacted_thinking blocks (chain-of-thought),
 *               tool_use blocks, usage, and stopReason — captured before the
 *               runner drops historical thinking blocks on the next turn.
 *
 * A single agent "prompt" can drive several model calls (one per assistant turn
 * in a tool-use loop); each call produces its own line, so nothing is lost.
 *
 * Opt-in via env:
 *   OPENCLAW_CONTEXT_CAPTURE=1         enable capture
 *   OPENCLAW_CONTEXT_CAPTURE_FILE=...  override output path (default:
 *                                      <workspaceDir>/context-log.jsonl)
 *   OPENCLAW_CONTEXT_CAPTURE_RAW=1     skip redaction (keep secrets + image
 *                                      base64 verbatim). Default redacts only
 *                                      credential-like fields and image blobs;
 *                                      all conversation/thinking text is kept.
 */

type ContextCaptureRecord = {
  ts: string;
  startedAt: string;
  stage: "turn";
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  requestSource: "wire-payload" | "context-fallback";
  request?: unknown;
  response?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  error?: string;
};

type ContextCaptureConfig = {
  enabled: boolean;
  raw: boolean;
  filePath: string;
};

type StreamResultCarrier = {
  result: () => Promise<AgentMessage>;
};

const writers = new Map<string, QueuedFileWriter>();
const log = createSubsystemLogger("agent/context-capture");

function resolveContextCaptureConfig(
  env: NodeJS.ProcessEnv,
  workspaceDir?: string,
): ContextCaptureConfig {
  const enabled = parseBooleanValue(env.OPENCLAW_CONTEXT_CAPTURE) ?? false;
  const raw = parseBooleanValue(env.OPENCLAW_CONTEXT_CAPTURE_RAW) ?? false;
  const fileOverride = env.OPENCLAW_CONTEXT_CAPTURE_FILE?.trim();
  let filePath: string;
  if (fileOverride) {
    filePath = resolveUserPath(fileOverride);
  } else if (workspaceDir && workspaceDir.trim().length > 0) {
    filePath = path.join(resolveUserPath(workspaceDir), "context-log.jsonl");
  } else {
    // No workspace and no override: keep capture self-contained in the state dir
    // rather than silently dropping it.
    filePath = path.join(resolveStateDir(env), "logs", "context-log.jsonl");
  }
  return { enabled, raw, filePath };
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error) ?? "unknown error";
  }
  return undefined;
}

export type ContextCaptureLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

export function createContextCaptureLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
}): ContextCaptureLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolveContextCaptureConfig(env, params.workspaceDir);
  if (!cfg.enabled) {
    return null;
  }

  const writer = params.writer ?? getQueuedFileWriter(writers, cfg.filePath);
  const prepare = (value: unknown): unknown => (cfg.raw ? value : sanitizeDiagnosticPayload(value));

  const base: Omit<
    ContextCaptureRecord,
    "ts" | "startedAt" | "stage" | "requestSource" | "request"
  > = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const record = (rec: ContextCaptureRecord) => {
    const line = safeJsonStringify(rec);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: ContextCaptureLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const startedAt = new Date().toISOString();
      let capturedPayload: unknown;
      let payloadSeen = false;
      let recorded = false;

      const nextOnPayload = (payload: unknown, payloadModel: Model<Api>) => {
        try {
          capturedPayload = prepare(payload);
          payloadSeen = true;
        } catch (err) {
          log.debug("context capture onPayload failed", { error: formatError(err) });
        }
        return options?.onPayload?.(payload, payloadModel);
      };

      const fallbackRequest = (): unknown => {
        const ctx = context as {
          systemPrompt?: unknown;
          messages?: unknown;
          thinking?: unknown;
          reasoning?: unknown;
        };
        return prepare({
          systemPrompt: ctx.systemPrompt,
          messages: ctx.messages,
          thinking: ctx.thinking,
          reasoning: ctx.reasoning,
        });
      };

      const writeTurn = (assistant?: AgentMessage, error?: unknown) => {
        if (recorded) {
          return;
        }
        recorded = true;
        const assistantRecord = assistant as { usage?: unknown; stopReason?: unknown } | undefined;
        record({
          ...base,
          ts: new Date().toISOString(),
          startedAt,
          stage: "turn",
          requestSource: payloadSeen ? "wire-payload" : "context-fallback",
          request: payloadSeen ? capturedPayload : fallbackRequest(),
          response: assistant ? prepare(assistant) : undefined,
          usage: assistantRecord?.usage,
          stopReason: assistantRecord?.stopReason,
          error: formatError(error),
        });
      };

      const wrapStream = (stream: Awaited<ReturnType<StreamFn>>) => {
        const carrier = stream as unknown as StreamResultCarrier;
        const originalResult = carrier.result.bind(carrier);
        carrier.result = async () => {
          try {
            const message = await originalResult();
            writeTurn(message);
            return message;
          } catch (err) {
            writeTurn(undefined, err);
            throw err;
          }
        };
        return stream;
      };

      try {
        const maybeStream = streamFn(model, context, { ...options, onPayload: nextOnPayload });
        if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
          return Promise.resolve(maybeStream).then(wrapStream, (err) => {
            writeTurn(undefined, err);
            throw err;
          });
        }
        return wrapStream(maybeStream);
      } catch (err) {
        writeTurn(undefined, err);
        throw err;
      }
    };
    return wrapped;
  };

  log.info("context capture logger enabled", { filePath: writer.filePath, raw: cfg.raw });
  return { enabled: true, wrapStreamFn };
}
