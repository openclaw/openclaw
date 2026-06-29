import { randomUUID } from "node:crypto";
import process from "node:process";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_CLASSIFY_TIMEOUT_MS = 2500;
const MIN_CLASSIFY_TIMEOUT_MS = 250;
const MAX_CLASSIFY_TIMEOUT_MS = 10000;
const HookLabel = {
  TOOL_RESPONSE: "tool_response",
} as const;

type RuntimeConfig = {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
  shadowMode: boolean;
  blockMalicious: boolean;
};

type RuntimeClient = {
  config: RuntimeConfig;
  classifier: SilmarilClassifier;
};

type Logger = {
  warn?: (message: string) => void;
};

type SafeClassification = {
  prediction?: unknown;
  score?: unknown;
  threshold?: unknown;
  primaryOutcome?: unknown;
};

type BlockResult = SafeClassification & {
  outcomeScores?: unknown;
  detectorScores?: unknown;
  detectorCounts?: unknown;
  blocked?: unknown;
};

type ClassifyOptions = {
  hook?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
};

type SilmarilClassifier = {
  classify(text: string, options?: ClassifyOptions): Promise<BlockResult | undefined>;
};

class DirectSilmarilClassifier implements SilmarilClassifier {
  constructor(private readonly config: RuntimeConfig) {}

  async classify(text: string, options: ClassifyOptions = {}): Promise<BlockResult | undefined> {
    const payload: Record<string, unknown> = {
      text: sanitizeText(text),
      metadata: withClientMetadata(options.metadata),
    };
    if (options.hook !== undefined) {
      payload.hook = options.hook;
    }
    if (options.toolName !== undefined) {
      payload.tool_name = options.toolName;
    }

    const { response, release } = await fetchWithSsrFGuard({
      url: this.config.apiUrl,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
        },
        body: JSON.stringify(payload),
        redirect: "error",
      },
      timeoutMs: this.config.timeoutMs,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(this.config.apiUrl),
      auditContext: "silmaril-firewall.classify",
    });

    try {
      if (!response.ok) {
        throw new Error(`Silmaril classify request failed with status ${response.status}`);
      }

      return blockResultFromResponse(await response.json());
    } finally {
      await release();
    }
  }
}

export function createSilmarilFirewallAgentToolResultMiddleware(
  rawConfig: unknown,
  logger?: Logger,
): AgentToolResultMiddleware {
  let missingConfigWarned = false;
  let runtimeClient: RuntimeClient | undefined;

  const getRuntime = (): RuntimeClient | undefined => {
    const config = resolveRuntimeConfig(rawConfig);
    if (!config) {
      if (!missingConfigWarned) {
        logger?.warn?.(
          "silmaril-firewall: apiKey or apiUrl missing - tool-result classifications skipped",
        );
        missingConfigWarned = true;
      }
      return undefined;
    }

    missingConfigWarned = false;
    if (!runtimeClient || !sameRuntimeConfig(runtimeClient.config, config)) {
      runtimeClient = {
        config,
        classifier: new DirectSilmarilClassifier(config),
      };
    }
    return runtimeClient;
  };

  return async (event, ctx) => {
    const runtime = getRuntime();
    if (!runtime) {
      return undefined;
    }

    const text = extractToolResultText(event.result);
    if (!text.trim()) {
      return undefined;
    }

    try {
      const result = await runtime.classifier.classify(text, {
        hook: HookLabel.TOOL_RESPONSE,
        toolName: event.toolName,
        metadata: {
          eventType: "agent_tool_result_middleware",
          runtime: ctx.runtime,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          cwd: readCwd(event),
          threadId: event.threadId,
          turnId: event.turnId,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
        },
      });

      if (!shouldBlockClassification(runtime.config, result)) {
        return undefined;
      }

      return {
        result: buildBlockedToolResult(event, result, ctx.runtime),
      };
    } catch {
      logger?.warn?.("silmaril-firewall: tool-result classification failed open");
      return undefined;
    }
  };
}

function resolveRuntimeConfig(rawConfig: unknown): RuntimeConfig | undefined {
  const config = readRecord(rawConfig);
  const apiKey = readString(config?.silmarilApiKey) ?? readString(config?.apiKey);
  const apiUrl = readString(config?.apiUrl);
  if (!apiKey || !apiUrl) {
    return undefined;
  }

  return {
    apiKey,
    apiUrl,
    timeoutMs:
      readIntegerInRange(config?.timeoutMs, MIN_CLASSIFY_TIMEOUT_MS, MAX_CLASSIFY_TIMEOUT_MS) ??
      DEFAULT_CLASSIFY_TIMEOUT_MS,
    shadowMode: readBoolean(config?.shadowMode) ?? true,
    blockMalicious: readBoolean(config?.blockMalicious) ?? false,
  };
}

function sameRuntimeConfig(left: RuntimeConfig, right: RuntimeConfig): boolean {
  return (
    left.apiKey === right.apiKey &&
    left.apiUrl === right.apiUrl &&
    left.timeoutMs === right.timeoutMs &&
    left.shadowMode === right.shadowMode &&
    left.blockMalicious === right.blockMalicious
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  const numberValue = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
    return undefined;
  }
  const integerValue = Math.trunc(numberValue);
  if (integerValue < min || integerValue > max) {
    return undefined;
  }
  return integerValue;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function sanitizeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code)) {
      if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
        out += text[i];
        out += text[i + 1];
        i += 1;
      }
      continue;
    }
    if (isLowSurrogate(code)) {
      continue;
    }
    out += text[i];
  }
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function withClientMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const payload = { ...metadata };
  const existing = readRecord(payload.silmaril);
  payload.silmaril = {
    ...existing,
    client_language: "typescript",
    client_name: "openclaw-bundled-silmaril-firewall",
    request_id: randomUUID(),
    input_index: 0,
    chunk_index: 0,
    chunk_count: 1,
  };
  return payload;
}

function readNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function blockResultFromResponse(data: unknown): BlockResult | undefined {
  const response = readRecord(data);
  if (!response) {
    return undefined;
  }
  return {
    prediction: response.prediction,
    score: readNumber(response.score),
    threshold: readNumber(response.threshold),
    primaryOutcome: response.primary_outcome ?? response.primaryOutcome,
    outcomeScores: response.outcome_scores ?? response.outcomeScores,
    detectorScores: response.detector_scores ?? response.detectorScores,
    detectorCounts: response.detector_counts ?? response.detectorCounts,
    blocked: response.blocked,
  };
}

function extractToolResultText(result: OpenClawAgentToolResult | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function shouldBlockClassification(
  config: RuntimeConfig,
  result: BlockResult | undefined,
): result is BlockResult {
  if (config.shadowMode || !config.blockMalicious || !result) {
    return false;
  }

  const primaryOutcome =
    typeof result.primaryOutcome === "string" ? result.primaryOutcome.toLowerCase() : undefined;
  const prediction =
    typeof result.prediction === "string" ? result.prediction.toLowerCase() : undefined;
  if (primaryOutcome === "benign") {
    return false;
  }
  if (prediction === "benign") {
    return false;
  }

  const score =
    typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined;
  const threshold =
    typeof result.threshold === "number" && Number.isFinite(result.threshold)
      ? result.threshold
      : undefined;
  if (score !== undefined && threshold !== undefined) {
    return score >= threshold;
  }

  const resultRecord = result as unknown as Record<string, unknown>;
  if (readBoolean(resultRecord.blocked) === true) {
    return true;
  }
  return (
    prediction === "malicious" || (primaryOutcome !== undefined && primaryOutcome !== "benign")
  );
}

function buildBlockedToolResult(
  event: AgentToolResultMiddlewareEvent,
  result: BlockResult,
  runtime: string,
): OpenClawAgentToolResult {
  const replacement = buildBlockedReplacement(event, result, runtime);
  return {
    ...event.result,
    content: [
      {
        type: "text",
        text: replacement,
      },
    ],
    details: {
      status: "blocked",
      silmarilFirewall: {
        blocked: true,
        hook: HookLabel.TOOL_RESPONSE,
        openClawHookEvent: "agent_tool_result_middleware",
        runtime,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        reason: "malicious tool output withheld before model reuse",
        classification: safeClassification(result),
      },
    },
  };
}

function buildBlockedReplacement(
  event: AgentToolResultMiddlewareEvent,
  result: BlockResult,
  runtime: string,
): string {
  return JSON.stringify(
    {
      silmarilFirewall: {
        blocked: true,
        hook: HookLabel.TOOL_RESPONSE,
        openClawHookEvent: "agent_tool_result_middleware",
        runtime,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        reason: "malicious tool output withheld before model reuse",
        classification: safeClassification(result),
      },
    },
    null,
    2,
  );
}

function safeClassification(result: BlockResult): SafeClassification {
  return {
    prediction: result.prediction,
    score: result.score,
    threshold: result.threshold,
    primaryOutcome: result.primaryOutcome,
  };
}

function readCwd(event: AgentToolResultMiddlewareEvent): string {
  if (event.cwd?.trim()) {
    return event.cwd;
  }
  const workdir = event.args.workdir;
  if (typeof workdir === "string" && workdir.trim()) {
    return workdir;
  }
  return process.cwd();
}

export const testInternals = {
  resolveRuntimeConfig,
  sameRuntimeConfig,
  readRecord,
  readString,
  readIntegerInRange,
  readBoolean,
  sanitizeText,
  withClientMetadata,
  blockResultFromResponse,
  extractToolResultText,
  shouldBlockClassification,
  buildBlockedToolResult,
  buildBlockedReplacement,
  safeClassification,
  readCwd,
};
