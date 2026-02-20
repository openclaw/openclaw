import { createHash } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { callGatewayTool, type GatewayCallOptions } from "./tools/gateway.js";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 10 * 60 * 1000;
const INTERRUPT_WAIT_TIMEOUT_BUFFER_MS = 15_000;
const MAX_INTERRUPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type PauseForApprovalDetails = {
  status: "paused_for_approval";
  approvalRequestId: string;
  interrupt: Record<string, unknown>;
  timeoutMs?: number;
};

export type PauseForApprovalContext = {
  runId?: string;
  sessionKey?: string;
  gateway?: GatewayCallOptions;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = normalizeForHash(record[key]);
  }
  return normalized;
}

function hashToolArgs(value: unknown): string {
  const normalized = normalizeForHash(value);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex");
}

function parsePauseForApproval(value: unknown): PauseForApprovalDetails | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  if (record.status !== "paused_for_approval") {
    return null;
  }
  const approvalRequestIdValue = record.approval_request_id ?? record.approvalRequestId;
  if (typeof approvalRequestIdValue !== "string" || !approvalRequestIdValue.trim()) {
    return null;
  }
  const interrupt = asRecord(record.interrupt);
  if (!interrupt) {
    return null;
  }
  const timeoutCandidate = record.timeout_ms ?? record.timeoutMs;
  const timeoutMs =
    typeof timeoutCandidate === "number" && Number.isFinite(timeoutCandidate)
      ? Math.max(1_000, Math.min(MAX_INTERRUPT_TIMEOUT_MS, Math.floor(timeoutCandidate)))
      : undefined;
  return {
    status: "paused_for_approval",
    approvalRequestId: approvalRequestIdValue.trim(),
    interrupt: { ...interrupt },
    timeoutMs,
  };
}

function extractPauseForApproval(result: unknown): PauseForApprovalDetails | null {
  const resultRecord = asRecord(result);
  if (!resultRecord) {
    return null;
  }
  const fromDetails = parsePauseForApproval(resultRecord.details);
  if (fromDetails) {
    return fromDetails;
  }
  return parsePauseForApproval(resultRecord);
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.content));
}

function toAgentToolResult(value: unknown): AgentToolResult<unknown> {
  if (isAgentToolResult(value)) {
    return value;
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? { status: "resumed" }, null, 2);
  return {
    content: [{ type: "text", text }],
    details: value,
  };
}

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw abortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function waitForResume(params: {
  runId: string;
  sessionKey: string;
  toolCallId: string;
  toolName: string;
  normalizedArgsHash: string;
  approvalRequestId: string;
  interrupt: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  gateway?: GatewayCallOptions;
}): Promise<AgentToolResult<unknown>> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
  const rpcTimeoutMs = timeoutMs + INTERRUPT_WAIT_TIMEOUT_BUFFER_MS;
  const waitPromise = callGatewayTool<{
    status?: string;
    result?: unknown;
  }>(
    "tool.interrupt.emit",
    {
      ...params.gateway,
      timeoutMs: rpcTimeoutMs,
    },
    {
      approvalRequestId: params.approvalRequestId,
      runId: params.runId,
      sessionKey: params.sessionKey,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      normalizedArgsHash: params.normalizedArgsHash,
      interrupt: params.interrupt,
      timeoutMs,
    },
    { expectFinal: true },
  );
  const resumed = await raceWithAbort(waitPromise, params.signal);
  if (resumed.status !== "resumed") {
    throw new Error("tool interrupt did not resume");
  }
  return toAgentToolResult(resumed.result);
}

export function wrapToolWithPauseForApproval(
  tool: AnyAgentTool,
  ctx?: PauseForApprovalContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await execute(toolCallId, params, signal, onUpdate);
      const paused = extractPauseForApproval(result);
      if (!paused) {
        return result;
      }
      const runId = ctx?.runId?.trim();
      const sessionKey = ctx?.sessionKey?.trim();
      const callId = toolCallId?.trim();
      if (!runId || !sessionKey || !callId) {
        throw new Error(
          `${toolName}: paused_for_approval requires runId, sessionKey, and toolCallId`,
        );
      }
      return await waitForResume({
        runId,
        sessionKey,
        toolCallId: callId,
        toolName,
        normalizedArgsHash: hashToolArgs(params),
        approvalRequestId: paused.approvalRequestId,
        interrupt: paused.interrupt,
        timeoutMs: paused.timeoutMs,
        signal,
        gateway: ctx?.gateway,
      });
    },
  };
}

export const __testing = {
  extractPauseForApproval,
  hashToolArgs,
};
