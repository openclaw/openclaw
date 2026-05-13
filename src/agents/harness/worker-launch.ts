import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { AgentFilesystemMode, AgentRunEvent, PreparedAgentRun } from "../runtime-backend.js";
import {
  createAgentWorkerPermissionProfile,
  type AgentWorkerPermissionMode,
  type AgentWorkerPermissionProfile,
} from "../runtime-worker-permissions.js";
import {
  createPreparedAgentRunFromAttempt,
  createPreparedAgentRunFromRunParams,
} from "./prepared-run.js";
import { forwardAgentRunEventToAttemptCallbacks } from "./run-event-bridge.js";
import type { AgentHarnessAttemptParams } from "./types.js";

export type AgentHarnessWorkerLaunchRequest = {
  preparedRun: PreparedAgentRun;
  signal?: AbortSignal;
  permissionProfile: AgentWorkerPermissionProfile;
  onEvent: (event: AgentRunEvent) => Promise<void>;
};

export type CreateAgentHarnessWorkerLaunchRequestOptions = {
  filesystemMode?: AgentFilesystemMode;
  permissionMode?: AgentWorkerPermissionMode;
  runtimeId: string;
};

export function createAgentHarnessWorkerLaunchRequest(
  attempt: AgentHarnessAttemptParams,
  options: CreateAgentHarnessWorkerLaunchRequestOptions,
): AgentHarnessWorkerLaunchRequest {
  const preparedRun = createPreparedAgentRunFromAttempt(attempt, {
    runtimeId: options.runtimeId,
    filesystemMode: options.filesystemMode ?? "disk",
  });
  return {
    preparedRun,
    signal: attempt.abortSignal,
    permissionProfile: createAgentWorkerPermissionProfile(preparedRun, {
      mode: options.permissionMode,
    }),
    onEvent: (event) => forwardAgentRunEventToAttemptCallbacks(attempt, event),
  };
}

export function createPiRunWorkerLaunchRequest(
  params: RunEmbeddedPiAgentParams,
  options: CreateAgentHarnessWorkerLaunchRequestOptions,
): AgentHarnessWorkerLaunchRequest {
  const preparedRun = createPreparedAgentRunFromRunParams(params, {
    runtimeId: options.runtimeId,
    filesystemMode: options.filesystemMode ?? "disk",
  });
  return {
    preparedRun,
    signal: params.abortSignal,
    permissionProfile: createAgentWorkerPermissionProfile(preparedRun, {
      mode: options.permissionMode,
    }),
    onEvent: (event) => forwardAgentRunEventToAttemptCallbacks(params, event),
  };
}
