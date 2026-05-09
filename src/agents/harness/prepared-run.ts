import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedRunAttemptParams } from "../pi-embedded-runner/run/types.js";
import {
  assertPreparedAgentRunSerializable,
  type AgentFilesystemMode,
  type PreparedAgentRun,
} from "../runtime-backend.js";
import {
  AGENT_RUN_PARENT_CALLBACK_FIELDS,
  AGENT_RUN_PARENT_MUTABLE_REF_FIELDS,
  AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS,
} from "./run-event-bridge.js";

type PreparedRunAttemptShape = Pick<
  EmbeddedRunAttemptParams,
  | "agentDir"
  | "agentId"
  | "config"
  | "hasRepliedRef"
  | "modelId"
  | "prompt"
  | "provider"
  | "replyOperation"
  | "runId"
  | "sessionId"
  | "sessionKey"
  | "shouldEmitToolOutput"
  | "shouldEmitToolResult"
  | "timeoutMs"
  | "workspaceDir"
>;

type PreparedRunParamsShape = Pick<
  RunEmbeddedPiAgentParams,
  | "agentDir"
  | "agentId"
  | "config"
  | "hasRepliedRef"
  | "model"
  | "prompt"
  | "provider"
  | "initialVfsEntries"
  | "replyOperation"
  | "runId"
  | "sessionId"
  | "sessionKey"
  | "shouldEmitToolOutput"
  | "shouldEmitToolResult"
  | "timeoutMs"
  | "workspaceDir"
>;

type PreparedRunSourceShape = PreparedRunParamsShape & {
  modelId?: string;
};

const PARENT_ONLY_RUN_PARAM_FIELDS = new Set<string>([
  ...AGENT_RUN_PARENT_CALLBACK_FIELDS,
  ...AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS,
  ...AGENT_RUN_PARENT_MUTABLE_REF_FIELDS,
  "agentFilesystem",
  "enqueue",
  "replyOperation",
]);

export type CreatePreparedAgentRunOptions = {
  filesystemMode?: AgentFilesystemMode;
  runtimeId?: string;
};

export function createPreparedAgentRunFromAttempt(
  attempt: PreparedRunAttemptShape,
  options: CreatePreparedAgentRunOptions = {},
): PreparedAgentRun {
  return createPreparedAgentRun(attempt, options);
}

export function createPreparedAgentRunFromRunParams(
  params: RunEmbeddedPiAgentParams,
  options: CreatePreparedAgentRunOptions = {},
): PreparedAgentRun {
  return createPreparedAgentRun(params, {
    ...options,
    runParams: createSerializableRunParamsSnapshot(params),
  });
}

function createPreparedAgentRun(
  source: PreparedRunSourceShape,
  options: CreatePreparedAgentRunOptions & { runParams?: Record<string, unknown> },
): PreparedAgentRun {
  const agentId = source.agentId ?? resolveAgentIdFromSessionKey(source.sessionKey);
  const preparedRun: PreparedAgentRun = {
    runtimeId: options.runtimeId ?? "pi",
    runId: source.runId,
    agentId,
    sessionId: source.sessionId,
    ...(source.sessionKey ? { sessionKey: source.sessionKey } : {}),
    workspaceDir: source.workspaceDir,
    ...(source.agentDir ? { agentDir: source.agentDir } : {}),
    prompt: source.prompt,
    provider: source.provider,
    model: source.modelId ?? source.model,
    timeoutMs: source.timeoutMs,
    filesystemMode: options.filesystemMode ?? "disk",
    ...(source.initialVfsEntries?.length ? { initialVfsEntries: source.initialVfsEntries } : {}),
    deliveryPolicy: {
      emitToolResult: source.shouldEmitToolResult?.() ?? false,
      emitToolOutput: source.shouldEmitToolOutput?.() ?? false,
      ...(source.hasRepliedRef ? { trackHasReplied: true } : {}),
      ...(source.replyOperation ? { bridgeReplyOperation: true } : {}),
    },
    ...(options.runParams ? { runParams: options.runParams } : {}),
    ...(source.config ? { config: source.config } : {}),
  };
  return assertPreparedAgentRunSerializable(preparedRun);
}

export function createSerializableRunParamsSnapshot(
  params: RunEmbeddedPiAgentParams,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || PARENT_ONLY_RUN_PARAM_FIELDS.has(key)) {
      continue;
    }
    snapshot[key] = value;
  }
  return snapshot;
}
