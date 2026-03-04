import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSystemKeychainProvider } from "../model-auth.js";
import type { ClaudeSdkSessionParams } from "./types.js";

export const CLAUDE_SDK_POLICY_WARNING_LINES = [
  "Important Anthropic policy notice:",
  "Anthropic has stated that using the Claude Agent SDK for 24/7 autonomous bots is prohibited.",
  "Using a personal Claude subscription (Claude Pro or Max) for business purposes, or for people other than the subscriber, violates Anthropic Terms of Service.",
] as const;

export const CLAUDE_SDK_POLICY_ACKNOWLEDGEMENT_MESSAGE =
  "I understand these Anthropic restrictions and will use this profile in compliance with the Terms.";

export const CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS = 4096;
export const CLAUDE_SDK_STDERR_TAIL_MAX_CHARS = 4096;

export type ClaudeSdkSpawnProcess = (options: SpawnOptions) => SpawnedProcess;
const log = createSubsystemLogger("agent/claude-sdk");

export function appendTail(
  currentTail: string | undefined,
  chunk: string,
  maxChars: number,
): string {
  if (!chunk) {
    return currentTail ?? "";
  }
  const next = `${currentTail ?? ""}${chunk}`;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(-maxChars);
}

function appendStdoutTail(currentTail: string, chunk: string, maxTailChars: number): string {
  if (!chunk) {
    return currentTail;
  }
  const next = `${currentTail}${chunk}`;
  if (next.length <= maxTailChars) {
    return next;
  }
  return next.slice(-maxTailChars);
}

export function defaultClaudeSdkSpawnProcess(options: SpawnOptions): SpawnedProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function createClaudeSdkSpawnWithStdoutTailLogging(options?: {
  baseSpawn?: ClaudeSdkSpawnProcess;
  maxTailChars?: number;
  onExitCodeOne?: (stdoutTail: string) => void;
}): ClaudeSdkSpawnProcess {
  const baseSpawn = options?.baseSpawn ?? defaultClaudeSdkSpawnProcess;
  const maxTailChars = Math.max(1, options?.maxTailChars ?? CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS);

  return (spawnOptions: SpawnOptions): SpawnedProcess => {
    const process = baseSpawn(spawnOptions);
    let stdoutTail = "";

    process.stdout.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutTail = appendStdoutTail(stdoutTail, text, maxTailChars);
    });

    process.once("exit", (code: number | null) => {
      if (code === 1) {
        options?.onExitCodeOne?.(stdoutTail);
      }
    });

    return process;
  };
}

export function createStdoutExitCodeOneLogger(params: {
  log: { error: (message: string) => void };
  maxTailChars?: number;
}): (stdoutTail: string) => void {
  const maxTailChars = params.maxTailChars ?? CLAUDE_SDK_STDOUT_TAIL_MAX_CHARS;
  return (stdoutTail: string): void => {
    const trimmed = stdoutTail.trim();
    if (!trimmed) {
      params.log.error("Claude Code subprocess exited with code 1 (stdout was empty).");
      return;
    }
    params.log.error(
      `Claude Code subprocess exited with code 1. stdout tail (last ${maxTailChars} chars):\n${trimmed}`,
    );
  };
}

export function enrichSubprocessExitErrorWithStderr(
  error: Error,
  stderrTail: string | undefined,
): void {
  if (!stderrTail) {
    return;
  }
  error.message = `${error.message}\nSubprocess stderr: ${stderrTail}`;
}

export function emitClaudeSdkMetric(
  metric: string,
  params: Pick<
    ClaudeSdkSessionParams,
    "runId" | "sessionId" | "sessionKey" | "provider" | "modelId" | "attemptNumber"
  >,
  fields: Record<string, unknown>,
  diagnosticsEnabled = false,
): void {
  const payload: Record<string, unknown> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider ?? "claude-sdk",
    model: params.modelId,
    attempt: params.attemptNumber,
    ...fields,
  };
  emitClaudeSdkMetricFields(metric, payload, diagnosticsEnabled);
}

export function emitClaudeSdkMetricFields(
  metric: string,
  fields: Record<string, unknown>,
  diagnosticsEnabled = false,
): void {
  log.info(`[claude-sdk-metric] ${metric} ${JSON.stringify(fields)}`);
  if (!diagnosticsEnabled) {
    return;
  }
  emitDiagnosticEvent({
    type: "runtime.metric",
    metric,
    runId: typeof fields.runId === "string" ? fields.runId : undefined,
    sessionId: typeof fields.sessionId === "string" ? fields.sessionId : undefined,
    sessionKey: typeof fields.sessionKey === "string" ? fields.sessionKey : undefined,
    provider: typeof fields.provider === "string" ? fields.provider : undefined,
    model: typeof fields.model === "string" ? fields.model : undefined,
    attempt: typeof fields.attempt === "number" ? fields.attempt : undefined,
    fields,
  });
}

export function isClaudeSubscriptionProvider(provider: string | undefined): boolean {
  return isSystemKeychainProvider(provider);
}

export function getClaudeSdkPolicyWarningText(): string {
  return CLAUDE_SDK_POLICY_WARNING_LINES.join(" ");
}

export function emitClaudeSdkPolicyWarningLines(params: {
  log: (message: string) => void;
  padding?: boolean;
}): void {
  if (params.padding) {
    params.log("");
  }
  for (const line of CLAUDE_SDK_POLICY_WARNING_LINES) {
    params.log(line);
  }
  if (params.padding) {
    params.log("");
  }
}
