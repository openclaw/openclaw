import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentRuntimeCacheStore } from "./cache/agent-cache-store.js";
import type { AgentFilesystem } from "./filesystem/agent-filesystem.js";

export type AgentFilesystemMode = "disk" | "vfs-only" | "vfs-scratch";

export type PreparedAgentRunInitialVfsEntry = {
  path: string;
  contentBase64: string;
  metadata?: Record<string, unknown>;
};

export type PreparedAgentRun = {
  runtimeId: string;
  runId: string;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  prompt: string;
  provider?: string;
  model?: string;
  timeoutMs: number;
  filesystemMode: AgentFilesystemMode;
  initialVfsEntries?: PreparedAgentRunInitialVfsEntry[];
  deliveryPolicy: AgentRunDeliveryPolicy;
  runParams?: Record<string, unknown>;
  config?: OpenClawConfig;
};

export type AgentRunEventStream =
  | "final"
  | "lifecycle"
  | "reasoning"
  | "tool"
  | "usage"
  | (string & {});

export type AgentRunEvent = {
  runId: string;
  stream: AgentRunEventStream;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export type AgentRunResult = {
  ok: boolean;
  text?: string;
  error?: string;
  usage?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

export type AgentRunDeliveryPolicy = {
  emitToolResult: boolean;
  emitToolOutput: boolean;
  trackHasReplied?: boolean;
  bridgeReplyOperation?: boolean;
};

export type AgentRuntimeContext = {
  filesystem: AgentFilesystem;
  cache?: AgentRuntimeCacheStore;
  emit: (event: AgentRunEvent) => void | Promise<void>;
  signal?: AbortSignal;
  control?: AgentRuntimeControl;
};

export type AgentRuntimeControlMessage =
  | {
      type: "queue_message";
      text: string;
    }
  | {
      type: "cancel";
      reason?: "user_abort" | "restart" | "superseded";
    };

export type AgentRuntimeControl = {
  onMessage(handler: (message: AgentRuntimeControlMessage) => void | Promise<void>): () => void;
};

export type AgentRuntimeBackend<
  TRun extends PreparedAgentRun = PreparedAgentRun,
  TResult extends AgentRunResult = AgentRunResult,
> = {
  id: string;
  run(preparedRun: TRun, context: AgentRuntimeContext): Promise<TResult>;
};

export function assertPreparedAgentRunSerializable(run: PreparedAgentRun): PreparedAgentRun {
  const requiredStringFields = [
    "runtimeId",
    "runId",
    "agentId",
    "sessionId",
    "workspaceDir",
    "prompt",
  ] satisfies (keyof PreparedAgentRun)[];
  const missing = requiredStringFields.filter((key) => {
    const value = run[key];
    return typeof value !== "string" || !value.trim();
  });
  if (missing.length > 0) {
    throw new Error(`Prepared agent run is missing required field(s): ${missing.join(", ")}`);
  }
  if (!Number.isFinite(run.timeoutMs) || run.timeoutMs <= 0) {
    throw new Error("Prepared agent run timeoutMs must be a positive finite number.");
  }
  if (!["disk", "vfs-scratch", "vfs-only"].includes(run.filesystemMode)) {
    throw new Error(`Prepared agent run filesystemMode is unsupported: ${run.filesystemMode}`);
  }
  if (
    typeof run.deliveryPolicy?.emitToolResult !== "boolean" ||
    typeof run.deliveryPolicy.emitToolOutput !== "boolean" ||
    (run.deliveryPolicy.trackHasReplied !== undefined &&
      typeof run.deliveryPolicy.trackHasReplied !== "boolean") ||
    (run.deliveryPolicy.bridgeReplyOperation !== undefined &&
      typeof run.deliveryPolicy.bridgeReplyOperation !== "boolean")
  ) {
    throw new Error("Prepared agent run deliveryPolicy must include boolean emit decisions.");
  }
  try {
    structuredClone(run);
  } catch (error) {
    throw new Error("Prepared agent run must be structured-clone serializable.", { cause: error });
  }
  return run;
}
