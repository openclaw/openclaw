import { setTimeout as delay } from "node:timers/promises";
import { redactSensitiveText, redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { escapeRegExp, sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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
    onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
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
  onOutputChunk?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
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
      ...(params.onOutputChunk ? { onOutputChunk: params.onOutputChunk } : {}),
    });
  } catch (error) {
    params.signal?.throwIfAborted();
    throw crabboxExecutionError(params.action, error);
  }
  // The runner owns child/tree settlement; cancellation must not release that custody early.
  params.signal?.throwIfAborted();
  return result;
}

export function crabboxExecutionError(action: string, cause: unknown): Error {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "unknown runner failure";
  const detail = redactToolPayloadText(message).replace(/\s+/gu, " ").trim();
  return new Error(
    `Crabbox ${action} execution failed: ${sliceUtf16Safe(detail, -MAX_COMMAND_DETAIL_CHARS)}`,
  );
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

type CrabboxCommandResult = SpawnResult & {
  coordinatorAttempts?: number;
  coordinatorDetail?: string;
};

export function crabboxCommandError(action: string, result: CrabboxCommandResult): Error {
  const attempts = result.coordinatorAttempts
    ? ` (after ${result.coordinatorAttempts} attempts)`
    : "";
  const detail = crabboxCommandDetail(result) || result.coordinatorDetail || "";
  if (result.termination !== "exit") {
    return new Error(
      `Crabbox ${action} did not exit normally (${result.termination})${detail}${attempts}`,
    );
  }
  return new Error(
    `Crabbox ${action} failed with exit code ${result.code ?? "unknown"}${detail}${attempts}`,
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

function isCoordinatorTransportFailure(result: SpawnResult): boolean {
  if (result.termination !== "exit" || result.code === null || result.code === 0) {
    return false;
  }
  let hasLeaseTimeout = false;
  const lines = `${result.stderr}\n${result.stdout}`.trim().split(/[\r\n]+/u);
  return (
    lines.every((line) => {
      const diagnostic = line.replace(/^warning: could not inspect lease before release: /u, "");
      if (
        /^(?:context deadline exceeded\s+)?(?:Get|Post) "https:\/\/[^/\s"]+\/v1\/leases\/[^/\s"?]+(?:\/(?:release|heartbeat))?(?:\?[^\s"]*)?": context deadline exceeded$/u.test(
          diagnostic,
        )
      ) {
        hasLeaseTimeout = true;
        return true;
      }
      // Any other output may be from a remote script that already started.
      return (
        diagnostic === "context deadline exceeded" ||
        /^coordinator read retry \d+\/\d+ reason=timeout$/u.test(diagnostic)
      );
    }) && hasLeaseTimeout
  );
}

export function isFixedLeaseIdUnsupported(result: SpawnResult, provider: string): boolean {
  return (
    result.termination === "exit" &&
    result.code === 2 &&
    result.stdout.trim() === "" &&
    result.stderr.trim() === `provider=${provider} does not support fixed idempotent lease IDs`
  );
}

/** Only fixed-lease callers opt in; allocation keeps Gateway replay ownership. */
export async function runCrabboxCommandWithCoordinatorRetry(
  params: Parameters<typeof runCrabboxCommand>[0] & {
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<CrabboxCommandResult> {
  const deadline = Date.now() + params.timeoutMs;
  const sleep = params.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let timeoutMs = params.timeoutMs;
  let coordinatorDetail: string | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const result = await runCrabboxCommand({ ...params, timeoutMs });
    const transient = isCoordinatorTransportFailure(result);
    if (transient) {
      coordinatorDetail = crabboxCommandDetail(result);
    }
    const observed =
      transient || attempt > 1
        ? { ...result, coordinatorAttempts: attempt, coordinatorDetail }
        : result;
    const backoffMs = 1_000 * 2 ** (attempt - 1);
    if (!transient || attempt === 3 || deadline - Date.now() <= backoffMs) {
      return observed;
    }
    await sleep(backoffMs, params.signal);
    params.signal?.throwIfAborted();
    timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) {
      return observed;
    }
  }
}

export function isUnrecognizedLease(
  result: SpawnResult,
  identifier: string,
  action: "inspect" | "stop",
): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    result.termination !== "exit" ||
    result.code === null ||
    result.code === 0 ||
    !new RegExp(`(?:^|[^\\w-])${escapeRegExp(identifier)}(?=$|[^\\w-])`, "u").test(output) ||
    /\b(?:access\s+denied|auth|authentication|authorization|credentials?|forbidden|permission|token|unauthorized)\b/iu.test(
      output,
    )
  ) {
    return false;
  }
  if (/\bcoordinator\b/iu.test(output)) {
    const responses = output
      .trim()
      .split(/[\r\n]+/u)
      .map((line) =>
        line.match(
          /^(?:warning: could not inspect lease before release: )?coordinator (GET|POST) (?:https?:\/\/[^/\s]+)?\/v1\/leases\/([^/:?\s]+)(\/release)?(?:\?[^\s:]*)?:[ \t]*http (\d{3})\b([^\r\n]*)$/iu,
        ),
      );
    const hasRead = responses.some(
      (response) =>
        response?.[1] === "GET" &&
        response[2] === identifier &&
        !response[3] &&
        response[4] === "404",
    );
    if (action === "inspect") {
      return hasRead;
    }
    // A missing read alone cannot attest release. Accept only complete, matching
    // read/release not_found diagnostics, with no other failure output.
    return (
      hasRead &&
      responses.some((response) => response?.[1] === "POST" && response[3] === "/release") &&
      responses.every(
        (response) =>
          response?.[2] === identifier &&
          response[4] === "404" &&
          (response[1] === "GET" ? !response[3] : response[3] === "/release") &&
          /^:\s*(?:not_found|\{\s*"error"\s*:\s*"not_found"\s*\})\s*$/u.test(response[5] ?? ""),
      )
    );
  }
  return (
    (result.code === 4 &&
      (/\b(?:was\s+)?not found\b/iu.test(output) ||
        /\bno longer exists\b/iu.test(output) ||
        /\b(?:points to|is bound to) (?:a )?missing (?:instance|sandbox)\b/iu.test(output) ||
        /\bdisappeared before release\b/iu.test(output) ||
        /\bunknown blacksmith testbox(?:\s|:)/iu.test(output) ||
        (action === "inspect" &&
          (/\bis not claimed by Crabbox\b/iu.test(output) ||
            /\bwandb sandbox "[^"\r\n]+" has no matching local ownership claim\b/iu.test(
              output,
            ))) ||
        /\bunknown lease(?:\s|:)/iu.test(output))) ||
    (action === "inspect" &&
      result.code === 5 &&
      /\bcoder workspace "[^"\r\n]+" not found\b/iu.test(output))
  );
}

export async function stopCrabboxLease(params: {
  binary: string;
  id: string;
  provider: string;
  runCommand: CrabboxCommandRunner;
  warn: (message: string) => void;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + CRABBOX_STOP_TIMEOUT_MS;
  let result = await runCrabboxCommandWithCoordinatorRetry({
    action: "stop",
    args: ["stop", "--provider", params.provider, "--id", params.id],
    binary: params.binary,
    runCommand: params.runCommand,
    sleep: params.sleep,
    timeoutMs: CRABBOX_STOP_TIMEOUT_MS,
  });
  if (isUnrecognizedLease(result, params.id, "stop")) {
    params.warn(
      `Crabbox lease ${params.id} (provider ${params.provider}) is absent; treating stop as already released`,
    );
    return;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    params.provider === "azure" &&
    result.termination === "exit" &&
    result.code === 4 &&
    output.includes("Azure fixed lease cannot be adopted without its create intent")
  ) {
    // Recovery shares the cleanup allowance reserved by the provider lifecycle.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Crabbox stop timed out before Azure fixed-lease recovery", {
        cause: crabboxCommandError("stop", result),
      });
    }
    result = await runCrabboxCommandWithCoordinatorRetry({
      action: "stop recovery",
      args: ["stop", "--provider", params.provider, "--id", params.id, "--force"],
      binary: params.binary,
      runCommand: params.runCommand,
      sleep: params.sleep,
      timeoutMs: remainingMs,
    });
  }
  crabboxCommandOutput("stop", result);
}
