/**
 * Bounded initialize handshake that qualifies a user-installed Codex before
 * selection. The candidate runs privately against a throwaway CODEX_HOME: it is
 * never registered as a Gateway app-server and never opens OpenClaw state.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runUtf8CommandWithTimeout, signalProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  buildCodexAppServerInitializeParams,
  readCodexVersionFromUserAgent,
} from "./client-initialize.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { INSTALLED_CODEX_PROBE_TIMEOUT_MS as HANDSHAKE_TIMEOUT_MS } from "./managed-binary.js";
import {
  resolveCodexAppServerSpawnEnv,
  resolveCodexAppServerSpawnInvocation,
} from "./transport-stdio.js";

const HANDSHAKE_MAX_OUTPUT_CHARS = 1024 * 1024;
const HANDSHAKE_EXIT_TIMEOUT_MS = 2_000;
const INITIALIZE_REQUEST_ID = 1;

async function assertProbeCanOverrideStorage(timeoutMs: number): Promise<void> {
  const metadataOptions = {
    baseEnv: { ...process.env, LC_ALL: "C" },
    input: "",
    timeoutMs: Math.min(1_000, timeoutMs),
    maxOutputBytes: 4_096,
    killProcessTree: true,
    killSignal: "SIGKILL" as const,
    killGraceMs: 0,
  };
  // Requirements and legacy managed layers can override even -c flags.
  let managedPaths = ["/etc/codex/managed_config.toml", "/etc/codex/requirements.toml"];
  if (process.platform === "win32") {
    const result = await runUtf8CommandWithTimeout(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('CommonApplicationData')",
      ],
      metadataOptions,
    );
    const programData = result.stdout.trim();
    if (
      result.termination !== "exit" ||
      result.code !== 0 ||
      result.outputLimitExceeded ||
      !path.win32.isAbsolute(programData)
    ) {
      throw new Error("cannot locate managed Codex requirements for an isolated selection probe");
    }
    managedPaths = [path.win32.join(programData, "OpenAI", "Codex", "requirements.toml")];
  }
  for (const managedPath of managedPaths) {
    const exists = await access(managedPath).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return false;
        }
        throw error;
      },
    );
    if (exists) {
      throw new Error("managed Codex configuration prevents an isolated selection probe");
    }
  }
  if (process.platform === "darwin") {
    // read-type reveals only presence/type, never the configuration's contents.
    for (const key of ["config_toml_base64", "requirements_toml_base64"]) {
      const result = await runUtf8CommandWithTimeout(
        ["/usr/bin/defaults", "read-type", "com.openai.codex", key],
        metadataOptions,
      );
      const missing =
        result.stderr.includes("does not exist") ||
        result.stderr.includes(`Could not find key '${key}'`) ||
        result.stderr.includes("Domain 'com.openai.codex' not found.");
      if (
        result.termination !== "exit" ||
        result.code !== 1 ||
        result.outputLimitExceeded ||
        !missing
      ) {
        throw new Error("managed Codex preferences cannot be excluded from the selection probe");
      }
    }
  }
}

/** Sends one initialize request and returns the Codex version from its reply. */
export async function probeCodexAppServerHandshake(
  command: string,
  timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<string | undefined> {
  const deadline = performance.now() + timeoutMs;
  await assertProbeCanOverrideStorage(timeoutMs);
  const codexHome = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-probe-"),
  );
  try {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throw new Error("selection probe timed out before initialize");
    }
    return await exchangeInitialize(command, codexHome, remainingMs);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function exchangeInitialize(
  command: string,
  codexHome: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const options: CodexAppServerStartOptions = {
    transport: "stdio",
    command,
    commandSource: "resolved-managed",
    // CLI flags override system/user defaults; the check above excludes legacy
    // managed layers, which Codex intentionally places above these flags.
    args: ["-c", `sqlite_home=${JSON.stringify(codexHome)}`, "app-server", "--listen", "stdio://"],
    headers: {},
    // Codex may otherwise prefer an inherited database root over CODEX_HOME.
    env: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome },
  };
  // Same argv and environment filtering as the real start, minus registration.
  const env = resolveCodexAppServerSpawnEnv(options);
  const invocation = resolveCodexAppServerSpawnInvocation(options, env);
  // A private process group stops the npm launcher and its native child together.
  const detached = process.platform !== "win32";
  const child = spawn(invocation.command, invocation.argv, {
    env,
    detached,
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
  const closed = once(child, "close").then(
    () => undefined,
    () => undefined,
  );
  try {
    return await readInitializeReply(child, timeoutMs);
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      signalProcessTree(child.pid, "SIGKILL", { detached });
    }
    await Promise.race([closed, delay(HANDSHAKE_EXIT_TIMEOUT_MS, undefined, { ref: false })]);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function readInitializeReply(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string | undefined> {
  const { promise, resolve, reject } = createDeferred<string | undefined>();
  let pending = "";
  let received = 0;
  let stderrTail = "";
  const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    const stderr = stderrTail.trim();
    reject(
      new Error(
        `exited (${signal ?? code}) before answering initialize${stderr ? `: ${stderr}` : ""}`,
      ),
    );
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-1024);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    received += chunk.length;
    if (received > HANDSHAKE_MAX_OUTPUT_CHARS) {
      reject(new Error("output exceeded its capture limit before initialize"));
      return;
    }
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const reply = parseInitializeReply(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (reply && "error" in reply) {
        reject(new Error(`initialize failed: ${JSON.stringify(reply.error).slice(0, 512)}`));
        return;
      }
      if (reply) {
        resolve(readCodexVersionFromUserAgent(reply.userAgent));
        return;
      }
    }
  });
  // A candidate that exits early reports through its exit event, not EPIPE.
  child.stdin.on("error", () => undefined);
  child.stdin.write(
    `${JSON.stringify({
      id: INITIALIZE_REQUEST_ID,
      method: "initialize",
      params: buildCodexAppServerInitializeParams(),
    })}\n`,
  );
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

/** Codex frames JSON-RPC as one JSON object per line, without a `jsonrpc` field. */
function parseInitializeReply(
  line: string,
): { userAgent: string | undefined } | { error: unknown } | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null || !("id" in message)) {
    return undefined;
  }
  if (message.id !== INITIALIZE_REQUEST_ID) {
    return undefined;
  }
  if ("error" in message) {
    return { error: message.error };
  }
  const result = "result" in message ? message.result : undefined;
  const userAgent =
    typeof result === "object" && result !== null && "userAgent" in result
      ? result.userAgent
      : undefined;
  return { userAgent: typeof userAgent === "string" ? userAgent : undefined };
}
