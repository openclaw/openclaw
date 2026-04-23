import fs from "node:fs/promises";
import path from "node:path";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import { resolveUserPath } from "openclaw/plugin-sdk/agent-harness";

type CodexTrajectoryRecorder = {
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
  env?: NodeJS.ProcessEnv;
};

const SENSITIVE_FIELD_RE = /(?:authorization|cookie|credential|key|password|passwd|secret|token)/iu;
const PRIVATE_PAYLOAD_FIELD_RE = /(?:image|screenshot|attachment|fileData|dataUri)/iu;

export function createCodexTrajectoryRecorder(
  params: CodexTrajectoryInit,
): CodexTrajectoryRecorder | null {
  const env = params.env ?? process.env;
  const enabled = parseTrajectoryEnabled(env);
  if (!enabled) {
    return null;
  }

  const filePath = resolveTrajectoryFilePath({
    env,
    sessionFile: params.attempt.sessionFile,
    sessionId: params.attempt.sessionId,
  });
  const ready = fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();
  let seq = 0;

  return {
    filePath,
    recordEvent: (type, data) => {
      const event = {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.attempt.sessionId,
        source: "runtime",
        type,
        ts: new Date().toISOString(),
        seq: (seq += 1),
        sourceSeq: seq,
        sessionId: params.attempt.sessionId,
        sessionKey: params.attempt.sessionKey,
        runId: params.attempt.runId,
        workspaceDir: params.cwd,
        provider: params.attempt.provider,
        modelId: params.attempt.modelId,
        modelApi: params.attempt.model.api,
        data: data ? sanitizeValue(data) : undefined,
      };
      const line = `${JSON.stringify(event)}\n`;
      queue = queue
        .then(() => ready)
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .catch(() => undefined);
    },
    flush: async () => {
      await queue;
    },
  };
}

export function recordCodexTrajectoryContext(
  recorder: CodexTrajectoryRecorder | null,
  params: CodexTrajectoryInit,
): void {
  if (!recorder) {
    return;
  }
  recorder.recordEvent("context.compiled", {
    systemPrompt: params.developerInstructions,
    prompt: params.attempt.prompt,
    imagesCount: params.attempt.images?.length ?? 0,
    tools: toTrajectoryToolDefinitions(params.tools),
  });
}

export function recordCodexTrajectoryCompletion(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    attempt: EmbeddedRunAttemptParams;
    result: EmbeddedRunAttemptResult;
    threadId: string;
    turnId: string;
    timedOut: boolean;
    yieldDetected?: boolean;
  },
): void {
  if (!recorder) {
    return;
  }
  recorder.recordEvent("model.completed", {
    threadId: params.threadId,
    turnId: params.turnId,
    timedOut: params.timedOut,
    yieldDetected: params.yieldDetected ?? false,
    aborted: params.result.aborted,
    promptError: normalizeCodexTrajectoryError(params.result.promptError),
    usage: params.result.attemptUsage,
    assistantTexts: params.result.assistantTexts,
    messagesSnapshot: params.result.messagesSnapshot,
  });
}

function parseTrajectoryEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPENCLAW_TRAJECTORY?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return true;
}

function resolveTrajectoryFilePath(params: {
  env: NodeJS.ProcessEnv;
  sessionFile: string;
  sessionId: string;
}): string {
  const dirOverride = params.env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return path.join(resolveUserPath(dirOverride), `${params.sessionId}.jsonl`);
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

function toTrajectoryToolDefinitions(
  tools: Array<{ name?: string; description?: string; inputSchema?: unknown }> | undefined,
): Array<{ name: string; description?: string; parameters?: unknown }> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools
    .flatMap((tool) => {
      const name = tool.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: tool.description,
          parameters: sanitizeValue(tool.inputSchema),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function sanitizeValue(value: unknown, depth = 0, key = ""): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (SENSITIVE_FIELD_RE.test(key)) {
      return "<redacted>";
    }
    if (value.startsWith("data:") && value.length > 256) {
      return `<redacted data-uri ${value.slice(0, value.indexOf(",")).length} chars>`;
    }
    if (PRIVATE_PAYLOAD_FIELD_RE.test(key) && value.length > 256) {
      return "<redacted payload>";
    }
    return value.length > 20_000 ? `${value.slice(0, 20_000)}…` : value;
  }
  if (depth >= 6) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeValue(entry, depth + 1, key));
  }
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      next[key] = sanitizeValue(child, depth + 1, key);
    }
    return next;
  }
  return JSON.stringify(value);
}

export function normalizeCodexTrajectoryError(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}
