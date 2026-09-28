import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { CRABBOX_STOP_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_DETAIL_CHARS = 512;

export type LeaseCommandContext = { binary: string; id: string; provider: string };

export function leaseRunArgs(
  context: LeaseCommandContext,
  forwardedEnvNames: readonly string[] = [],
  envProfilePath?: string,
): string[] {
  return [
    "run",
    "--provider",
    context.provider,
    "--network",
    "public",
    "--tailscale=false",
    "--id",
    context.id,
    "--keep=true",
    // Workspace transfer is owned by the worker tunnel; lease scripts must not
    // rsync the gateway checkout into the box just to execute setup or diagnostics.
    "--no-sync",
    ...forwardedEnvNames.flatMap((name) => ["--allow-env", name]),
    ...(envProfilePath ? ["--env-from-profile", envProfilePath] : []),
    "--script-stdin",
  ];
}

export type CrabboxCommandRunner = (
  argv: string[],
  options: {
    killProcessTree: boolean;
    env?: NodeJS.ProcessEnv;
    input?: string | Uint8Array;
    maxOutputBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
  },
) => Promise<SpawnResult>;

export async function runCrabboxCommand(params: {
  action: string;
  args: string[];
  binary: string;
  runCommand: CrabboxCommandRunner;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<SpawnResult> {
  params.signal?.throwIfAborted();
  let result: SpawnResult;
  try {
    result = await params.runCommand([params.binary, ...params.args], {
      timeoutMs: params.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killProcessTree: true,
      ...(params.env === undefined ? {} : { env: params.env }),
      ...(params.input === undefined ? {} : { input: params.input }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    params.signal?.throwIfAborted();
    throw new Error(`Crabbox ${params.action} could not start`);
  }
  // The runner owns child/tree settlement; cancellation must not release that custody early.
  params.signal?.throwIfAborted();
  return result;
}

function crabboxCommandDetail(result: SpawnResult): string {
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (!raw) {
    return "";
  }
  const compressed = redactSensitiveText(raw).replace(/\s+/gu, " ");
  // Failure diagnoses come last; Crabbox's fixed banner is leading boilerplate.
  // Keep stderr last, matching the per-stream suffix capture in src/process/exec-output.ts.
  const tailMarker = "... ";
  return compressed.length <= MAX_COMMAND_DETAIL_CHARS
    ? `: ${compressed}`
    : `: ${tailMarker}${sliceUtf16Safe(compressed, tailMarker.length - MAX_COMMAND_DETAIL_CHARS)}`;
}

export function crabboxCommandError(action: string, result: SpawnResult): Error {
  if (result.termination !== "exit") {
    return new Error(
      `Crabbox ${action} did not exit normally (${result.termination})${crabboxCommandDetail(result)}`,
    );
  }
  return new Error(
    `Crabbox ${action} failed with exit code ${result.code ?? "unknown"}${crabboxCommandDetail(result)}`,
  );
}

export function crabboxCommandOutput(action: string, result: SpawnResult): string {
  if (result.termination !== "exit" || result.code !== 0) {
    throw crabboxCommandError(action, result);
  }
  return result.stdout;
}

export function parseCrabboxJson(stdout: string, action: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Crabbox ${action} returned invalid JSON`);
  }
}

// Recognition failure does not prove resource absence; only the stop owner can confirm cleanup.
export function isUnrecognizedLease(result: SpawnResult, identifier: string): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    !output.includes(identifier) ||
    /\b(?:access\s+denied|authentication|authorization|credentials?|forbidden|permission|token|unauthorized)\b/iu.test(
      output,
    )
  ) {
    return false;
  }
  return (
    (result.code === 4 &&
      (/\b(?:was\s+)?not found\b/iu.test(output) ||
        /\bno longer exists\b/iu.test(output) ||
        /\b(?:points to|is bound to) (?:a )?missing (?:instance|sandbox)\b/iu.test(output) ||
        /\bdisappeared before release\b/iu.test(output) ||
        /\bunknown blacksmith testbox(?:\s|:)/iu.test(output) ||
        /\bis not claimed by Crabbox\b/iu.test(output) ||
        /\bwandb sandbox "[^"\r\n]+" has no matching local ownership claim\b/iu.test(output) ||
        /\bunknown lease(?:\s|:)/iu.test(output))) ||
    (result.code === 5 && /\bcoder workspace "[^"\r\n]+" not found\b/iu.test(output)) ||
    /\bcoordinator GET \S*\/v1\/leases\/\S+:\s*http 404\b/iu.test(output)
  );
}

export async function stopCrabboxLease(params: {
  binary: string;
  id: string;
  provider: string;
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "stop",
    args: ["stop", "--provider", params.provider, "--id", params.id],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: CRABBOX_STOP_TIMEOUT_MS,
  });
  crabboxCommandOutput("stop", result);
}
