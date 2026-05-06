import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { AgentRunResult, PreparedAgentRun } from "../runtime-backend.js";
import type { AgentFilesystemMode } from "../runtime-backend.js";
import type { AgentWorkerPermissionMode } from "../runtime-worker-permissions.js";
import { runPreparedAgentInWorker, type AgentWorkerControlChannel } from "../runtime-worker.js";
import { createPiRunWorkerLaunchRequest } from "./worker-launch.js";

export type PiRunWorkerRunnerDeps = {
  runPreparedAgentInWorker: typeof runPreparedAgentInWorker;
};

export type RunPiRunInWorkerOptions = {
  backendModuleUrl?: string;
  filesystemMode?: AgentFilesystemMode;
  onControlChannel?: (channel: AgentWorkerControlChannel) => void;
  permissionMode?: AgentWorkerPermissionMode;
  runtimeId?: string;
  workerEntryUrl?: URL;
};

function defaultPiWorkerBackendModuleUrl(): string {
  return new URL("./pi-worker-backend.js", import.meta.url).href;
}

function fallbackEmbeddedPiRunResult(result: AgentRunResult): EmbeddedPiRunResult {
  return {
    ...(result.text ? { payloads: [{ text: result.text }] } : {}),
    meta: { durationMs: 0 },
  };
}

export function embeddedPiRunResultFromWorkerResult(result: AgentRunResult): EmbeddedPiRunResult {
  const embedded = result.data?.embeddedPiRunResult;
  if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
    return embedded as unknown as EmbeddedPiRunResult;
  }
  return fallbackEmbeddedPiRunResult(result);
}

export function createPiRunWorkerRunner(deps: PiRunWorkerRunnerDeps) {
  return async function runPiRunInWorker(
    params: RunEmbeddedPiAgentParams,
    options: RunPiRunInWorkerOptions = {},
  ): Promise<EmbeddedPiRunResult> {
    const request = createPiRunWorkerLaunchRequest(params, {
      runtimeId: options.runtimeId ?? "pi",
      filesystemMode: options.filesystemMode ?? "disk",
      permissionMode: options.permissionMode,
    });
    const result = await deps.runPreparedAgentInWorker(request.preparedRun, {
      backendModuleUrl: options.backendModuleUrl ?? defaultPiWorkerBackendModuleUrl(),
      permissionProfile: request.permissionProfile,
      signal: request.signal,
      onEvent: request.onEvent,
      onControlChannel: options.onControlChannel,
      ...(options.workerEntryUrl ? { workerEntryUrl: options.workerEntryUrl } : {}),
    });
    if (!result.ok) {
      throw new Error(result.error || "PI worker run failed.");
    }
    return embeddedPiRunResultFromWorkerResult(result);
  };
}

export const runPiRunInWorker = createPiRunWorkerRunner({ runPreparedAgentInWorker });

export function createPiRunWorkerPreparedRunForTest(
  params: RunEmbeddedPiAgentParams,
): PreparedAgentRun {
  return createPiRunWorkerLaunchRequest(params, { runtimeId: "pi" }).preparedRun;
}
