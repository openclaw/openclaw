import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQaLiveTurnTimeoutMs as liveTurnTimeoutMs } from "./live-timeout.js";
import {
  getQaNativeWorkspaceBehavior,
  readQaNativeWorkspaceBehaviorId,
  type QaNativeWorkspaceBehavior,
} from "./native-workspace-behavior.js";
import { isWorkspaceBoundaryFailureToolOutput } from "./runtime-tool-evidence.js";
import type { runAgentPrompt } from "./suite-runtime-agent-process.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type NativeToolOutput = { hardFailure?: boolean; text: string };
type NativeToolEvidence = {
  plannedRequest?: unknown;
  executedRequest?: { args?: unknown };
  outputRequest?: NativeToolOutput;
  failureOutputRequest?: NativeToolOutput;
};

type NativeWorkspaceFixtureParams = {
  env: QaSuiteRuntimeEnv;
  behaviorId: unknown;
  required: boolean;
  happySessionKey: string;
  failureSessionKey: string;
  runAgentPrompt: (...args: Parameters<typeof runAgentPrompt>) => Promise<unknown>;
  readEvidence: (sessionKey: string, toolName: string) => Promise<NativeToolEvidence>;
  fixtureError: (error: unknown) => Error;
  failFixture: (details: string) => never;
};

export function canonicalWorkspacePath(workspaceDir: string, filePath: string): string {
  const resolvedPath = path.resolve(workspaceDir, filePath);
  try {
    // Native patch paths resolve platform aliases after the target leaf is removed.
    return path.join(realpathSync.native(path.dirname(resolvedPath)), path.basename(resolvedPath));
  } catch {
    return resolvedPath;
  }
}

function matchesNativeWorkspaceArguments(params: {
  args: unknown;
  behavior: QaNativeWorkspaceBehavior;
  phase: "happy" | "failure";
  workspaceDir: string;
}) {
  if (!isRecord(params.args)) {
    return false;
  }
  const expectedArgs =
    params.phase === "happy" ? params.behavior.happyArgs : params.behavior.failureArgs;
  if (params.behavior.nativeToolName === "bash") {
    const command = params.args.command;
    const signature = params.behavior.commandReceiptSignatures?.[params.phase];
    return Boolean(
      signature && typeof command === "string" && signature.every((part) => command.includes(part)),
    );
  }
  if (params.args.input === expectedArgs.input) {
    return true;
  }
  const expectedFile =
    params.phase === "happy"
      ? params.behavior.happyMutation?.path
      : params.behavior.failureSentinel?.path;
  const changes = params.args.changes;
  if (!expectedFile || !Array.isArray(changes) || changes.length !== 1 || !isRecord(changes[0])) {
    return false;
  }
  const kind = changes[0].kind;
  const changePath = changes[0].path;
  if (typeof changePath !== "string") {
    return false;
  }
  return (
    canonicalWorkspacePath(params.workspaceDir, changePath) ===
      canonicalWorkspacePath(params.workspaceDir, expectedFile) &&
    (isRecord(kind) ? kind.type : kind) === "update"
  );
}

export async function readOptionalUtf8(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
}

function nativePrompt(behavior: QaNativeWorkspaceBehavior, phase: "happy" | "failure") {
  const args = phase === "happy" ? behavior.happyArgs : behavior.failureArgs;
  return [
    `tool search qa ${phase === "happy" ? "check" : "failure"} target=${behavior.providerToolName}`,
    `native-workspace-behavior=${behavior.id}.`,
    `Call ${behavior.providerToolName} exactly once with these exact arguments: ${JSON.stringify(args)}.`,
    `Wait for its ${phase === "failure" ? "failed " : ""}result, then summarize the actual outcome.`,
  ].join(" ");
}

export async function runCodexNativeWorkspaceFixture(
  params: NativeWorkspaceFixtureParams,
): Promise<string | undefined> {
  const behaviorId = readQaNativeWorkspaceBehaviorId(params.behaviorId);
  if (!behaviorId) {
    return undefined;
  }
  const behavior = getQaNativeWorkspaceBehavior(behaviorId);
  const runOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw params.fixtureError(error);
    }
  };
  if (!params.required) {
    throw params.fixtureError(
      new Error(`codex-native ${behavior.id} behavior must be required coverage`),
    );
  }
  const workspaceRealPath = await runOperation(() => fs.realpath(params.env.gateway.workspaceDir));
  for (const seed of behavior.seedFiles ?? []) {
    const seedPath = path.resolve(params.env.gateway.workspaceDir, seed.path);
    await runOperation(async () => {
      const parentRealPath = await fs.realpath(path.dirname(seedPath));
      const existing = await fs.lstat(seedPath).catch((error: unknown) => {
        if (isRecord(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (!isPathInside(workspaceRealPath, parentRealPath) || existing?.isSymbolicLink()) {
        throw new Error(`refusing codex-native seed path outside the workspace: ${seed.path}`);
      }
      await fs.writeFile(seedPath, seed.contents, "utf8");
    });
  }

  const happyMutation = behavior.happyMutation;
  if (
    happyMutation &&
    !(behavior.seedFiles ?? []).some((seed) => seed.path === happyMutation.path)
  ) {
    await runOperation(() =>
      fs.rm(path.resolve(params.env.gateway.workspaceDir, happyMutation.path), { force: true }),
    );
  }

  await runOperation(() =>
    params.runAgentPrompt(params.env, {
      sessionKey: params.happySessionKey,
      message: nativePrompt(behavior, "happy"),
      timeoutMs: liveTurnTimeoutMs(params.env, 45_000),
      transcriptToolName: behavior.nativeToolName,
      requireSuccessfulTranscriptToolResult: true,
    }),
  );
  if (behavior.happyMutation) {
    const mutation = behavior.happyMutation;
    const contents = await runOperation(() =>
      readOptionalUtf8(path.resolve(params.env.gateway.workspaceDir, mutation.path)),
    );
    if (contents !== mutation.contents) {
      throw params.fixtureError(
        new Error(
          `expected codex-native ${behavior.id} to write ${mutation.path} with exact contents`,
        ),
      );
    }
  }

  const sentinel = behavior.failureSentinel;
  const sentinelPath = sentinel
    ? path.resolve(params.env.gateway.workspaceDir, sentinel.path)
    : undefined;
  if (sentinelPath && sentinel) {
    await runOperation(() =>
      fs.writeFile(sentinelPath, sentinel.contents, { encoding: "utf8", flag: "wx" }),
    );
  }
  try {
    await runOperation(() =>
      params.runAgentPrompt(params.env, {
        sessionKey: params.failureSessionKey,
        message: nativePrompt(behavior, "failure"),
        timeoutMs: liveTurnTimeoutMs(params.env, 45_000),
        transcriptToolName: behavior.nativeToolName,
      }),
    );
    if (sentinelPath && sentinel) {
      const contents = await runOperation(() => readOptionalUtf8(sentinelPath));
      if (contents !== sentinel.contents) {
        throw params.fixtureError(
          new Error(
            `codex-native ${behavior.id} modified or removed its outside-workspace sentinel`,
          ),
        );
      }
    }
  } finally {
    if (sentinelPath) {
      await fs.rm(sentinelPath, { force: true });
    }
  }

  for (const phase of ["happy", "failure"] as const) {
    const evidence = await runOperation(() =>
      params.readEvidence(
        phase === "happy" ? params.happySessionKey : params.failureSessionKey,
        behavior.nativeToolName,
      ),
    );
    const output = phase === "happy" ? evidence.outputRequest : evidence.failureOutputRequest;
    if (!output || (phase === "happy" && output.hardFailure)) {
      params.failFixture(
        evidence.plannedRequest
          ? `expected ${phase === "happy" ? "successful" : "failed"} codex-native ${behavior.id} result`
          : `expected codex-native ${behavior.id} ${phase === "happy" ? "call" : "failure call"} receipt`,
      );
    }
    if (
      !matchesNativeWorkspaceArguments({
        args: evidence.executedRequest?.args,
        behavior,
        phase,
        workspaceDir: params.env.gateway.workspaceDir,
      })
    ) {
      throw params.fixtureError(
        new Error(`codex-native ${behavior.id} ${phase} receipt had unexpected arguments`),
      );
    }
    const outputMarker =
      phase === "happy" ? behavior.happyOutputMarker : behavior.failureOutputMarker;
    if (outputMarker && !output.text.includes(outputMarker)) {
      throw params.fixtureError(
        new Error(`codex-native ${behavior.id} ${phase} result omitted its output marker`),
      );
    }
    if (
      phase === "failure" &&
      behavior.nativeToolName === "apply_patch" &&
      !isWorkspaceBoundaryFailureToolOutput(output.text)
    ) {
      throw params.fixtureError(
        new Error("expected codex-native edit failure to explicitly reject the workspace boundary"),
      );
    }
  }
  return `codex-native ${behavior.id} behavior passed`;
}

type DiagnosticRequest = { plannedToolArgs?: unknown };

export function formatCodexNativeWorkspaceDetails(params: {
  toolName: string;
  tools: Set<string>;
  reason?: string;
  happyRequest?: DiagnosticRequest;
  failureRequest?: DiagnosticRequest;
}) {
  const plannedArgs = (request: DiagnosticRequest) => JSON.stringify(request.plannedToolArgs ?? {});
  return [
    `codex-native-workspace ${params.toolName}: OpenClaw dynamic exposure is intentionally omitted because Codex owns this workspace operation natively`,
    params.reason ? `reason: ${params.reason}` : undefined,
    `available OpenClaw dynamic tools: ${[...params.tools].toSorted().join(", ")}`,
    params.happyRequest
      ? `${params.toolName} mock provider happy planned args (diagnostic only): ${plannedArgs(params.happyRequest)}`
      : undefined,
    params.failureRequest
      ? `${params.toolName} mock provider failure planned args (diagnostic only): ${plannedArgs(params.failureRequest)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
