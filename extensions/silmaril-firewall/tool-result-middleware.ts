import process from "node:process";
import { Firewall, HookLabel } from "@silmaril-security/sdk";
import type { BlockResult } from "@silmaril-security/sdk";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";

const DEFAULT_CLASSIFY_TIMEOUT_MS = 2500;
const MIN_CLASSIFY_TIMEOUT_MS = 250;
const MAX_CLASSIFY_TIMEOUT_MS = 10000;

type RuntimeConfig = {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
  shadowMode: boolean;
  blockMalicious: boolean;
};

type RuntimeClient = {
  config: RuntimeConfig;
  firewall: Firewall;
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
        firewall: new Firewall({
          apiKey: config.apiKey,
          apiUrl: config.apiUrl,
          timeoutMs: config.timeoutMs,
          shadowMode: config.shadowMode,
        }),
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
      const result = await runtime.firewall.classify(text, {
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

export const __testInternals = {
  resolveRuntimeConfig,
  sameRuntimeConfig,
  readRecord,
  readString,
  readIntegerInRange,
  readBoolean,
  extractToolResultText,
  shouldBlockClassification,
  buildBlockedToolResult,
  buildBlockedReplacement,
  safeClassification,
  readCwd,
};
