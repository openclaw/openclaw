import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isStandaloneRuntimeExecutable,
  resolveOpenClawCliInvocation,
} from "../../cli-invocation.mjs";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
import {
  listKnownProviderAuthEnvVarNamesCore,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
import { settlesWithin } from "../shared/settle-within.js";
import { classifyAcpToolApproval } from "./approval-classifier.js";

type AcpClientOptions = {
  cwd?: string;
  serverCommand?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  verbose?: boolean;
};

const ACP_SERVER_KILL_GRACE_MS = 1000;
const ACP_SERVER_FORCE_KILL_TIMEOUT_MS = 1000;

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!hasChildExited(child)) {
    await once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
  }
  return hasChildExited(child);
}

async function terminateAcpServer(child: ChildProcess): Promise<void> {
  if (hasChildExited(child)) {
    return;
  }

  if (child.pid) {
    // This child is not detached, so Unix cleanup must stay on its direct PID.
    // Windows still reaps descendants; both paths escalate if SIGTERM is ignored.
    killProcessTree(child.pid, {
      detached: false,
      graceMs: ACP_SERVER_KILL_GRACE_MS,
    });
  } else {
    child.kill("SIGTERM");
  }

  if (await waitForChildExit(child, ACP_SERVER_KILL_GRACE_MS + ACP_SERVER_FORCE_KILL_TIMEOUT_MS)) {
    return;
  }

  if (child.pid) {
    signalProcessTree(child.pid, "SIGKILL", { detached: false });
  } else {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, ACP_SERVER_FORCE_KILL_TIMEOUT_MS);
}

function resolveSelfEntryPath(): string | null {
  // Prefer a path relative to the built module location (dist/acp/client.js -> dist/entry.js).
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = path.resolve(path.dirname(here), "..", "entry.js");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // ignore
  }

  const argv1 = normalizeOptionalString(process.argv[1]);
  if (argv1) {
    return path.isAbsolute(argv1) ? argv1 : path.resolve(process.cwd(), argv1);
  }
  return null;
}

function printSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content?.type === "text") {
        process.stdout.write(update.content.text);
      }
      return;
    }
    case "tool_call": {
      console.log(`\n[tool] ${update.title} (${update.status})`);
      return;
    }
    case "tool_call_update": {
      if (update.status) {
        console.log(`[tool update] ${update.toolCallId}: ${update.status}`);
      }
      return;
    }
    case "available_commands_update": {
      const names = update.availableCommands?.map((cmd) => `/${cmd.name}`).join(" ");
      if (names) {
        console.log(`\n[commands] ${names}`);
      }
    }
    default:
  }
}

function promptUserPermission(
  toolName: string | undefined,
  toolTitle?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const finish = (approved: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onClose);
      rl.off("close", onClose);
      rl.close();
      resolve(approved);
    };

    const onClose = () => finish(false);
    rl.once("close", onClose);
    signal?.addEventListener("abort", onClose, { once: true });
    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);

    const label = toolTitle
      ? toolName
        ? `${toolTitle} (${toolName})`
        : toolTitle
      : (toolName ?? "unknown tool");
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = normalizeLowercaseStringOrEmpty(answer) === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}

async function createAcpClient(opts: AcpClientOptions = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const verbose = Boolean(opts.verbose);
  const log = verbose ? (msg: string) => console.error(`[acp-client] ${msg}`) : () => {};

  ensureOpenClawCliOnPath();
  const serverArgs = ["acp", ...(opts.serverArgs ?? [])];
  if (opts.serverVerbose && !serverArgs.includes("--verbose") && !serverArgs.includes("-v")) {
    serverArgs.push("--verbose");
  }

  const standalone = isStandaloneRuntimeExecutable();
  const entryPath = standalone ? undefined : resolveSelfEntryPath();
  const defaultInvocation =
    standalone || entryPath
      ? resolveOpenClawCliInvocation({ entryPath, args: serverArgs, execArgv: [] })
      : { command: "openclaw", args: serverArgs };
  const defaultServerCommand = defaultInvocation.command;
  const defaultServerArgs = defaultInvocation.args;
  const serverCommand = opts.serverCommand ?? defaultServerCommand;
  const effectiveArgs = opts.serverCommand ? serverArgs : defaultServerArgs;
  const { getActiveSkillEnvKeysCore } = await import("../skills/runtime/env-overrides.js");
  const normalizedServerCommand = normalizeOptionalString(serverCommand);
  const stripProviderAuthEnvVars =
    !normalizedServerCommand ||
    (normalizedServerCommand === normalizeOptionalString(defaultServerCommand) &&
      effectiveArgs.length === defaultServerArgs.length &&
      effectiveArgs.every((arg, index) => arg === defaultServerArgs[index]));
  const stripKeys = new Set(getActiveSkillEnvKeysCore());
  if (stripProviderAuthEnvVars) {
    for (const key of listKnownProviderAuthEnvVarNamesCore()) {
      stripKeys.add(key);
    }
  }
  const spawnEnv = omitEnvKeysCaseInsensitive(process.env, stripKeys);
  spawnEnv.OPENCLAW_SHELL = "acp-client";
  const spawnProgram = resolveWindowsSpawnProgram({
    command: serverCommand,
    platform: process.platform,
    env: spawnEnv,
    execPath: process.execPath,
    packageName: "openclaw",
  });
  const spawnInvocation = materializeWindowsSpawnProgram(spawnProgram, effectiveArgs);

  log(`spawning: ${spawnInvocation.command} ${spawnInvocation.argv.join(" ")}`);

  const agent = spawn(spawnInvocation.command, spawnInvocation.argv, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: spawnEnv,
    shell: spawnInvocation.shell,
    windowsHide: spawnInvocation.windowsHide,
  });

  const permissions = new AbortController();
  // Close joins stdio as well as process exit; install before the handshake.
  const closed = new Promise<void>((resolve) => {
    agent.once("close", () => resolve());
  });
  agent.on("error", (err) => {
    log(`agent error: ${String(err)}`);
  });

  try {
    if (!agent.stdin || !agent.stdout) {
      throw new Error("Failed to create ACP stdio pipes");
    }

    const input = Writable.toWeb(agent.stdin);
    const output = Readable.toWeb(agent.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          printSessionUpdate(params);
        },
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          if (permissions.signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
          }
          const options = params.options ?? [];
          const toolTitle = sanitizeTerminalText(params.toolCall?.title ?? "tool");
          const classification = classifyAcpToolApproval({ toolCall: params.toolCall, cwd });
          const toolName = classification.toolName;
          const toolKind =
            !toolName && classification.approvalClass === "unknown"
              ? undefined
              : classification.approvalClass;

          if (options.length === 0) {
            console.error(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
            return { outcome: { outcome: "cancelled" } };
          }

          const allowOption =
            options.find((option) => option.kind === "allow_once") ??
            options.find((option) => option.kind === "allow_always");
          const rejectOption =
            options.find((option) => option.kind === "reject_once") ??
            options.find((option) => option.kind === "reject_always");
          if (classification.autoApprove) {
            if (!allowOption) {
              console.error(
                `[permission cancelled] ${toolName ?? "unknown"}: missing allow option`,
              );
              return { outcome: { outcome: "cancelled" } };
            }
            console.error(`[permission auto-approved] ${toolName} (${toolKind ?? "unknown"})`);
            return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
          }

          console.error(
            `\n[permission requested] ${toolTitle}${toolName ? ` (${toolName})` : ""}${toolKind ? ` [${toolKind}]` : ""}`,
          );
          const approved = await promptUserPermission(toolName, toolTitle, permissions.signal);
          if (permissions.signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
          }

          if (approved && allowOption) {
            return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
          }
          if (!approved && rejectOption) {
            return { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
          }

          console.error(
            `[permission cancelled] ${toolName ?? "unknown"}: missing ${approved ? "allow" : "reject"} option`,
          );
          return { outcome: { outcome: "cancelled" } };
        },
      }),
      stream,
    );

    void client.closed.then(() => permissions.abort());
    log("initializing");
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "openclaw-acp-client", version: "1.0.0" },
    });

    log("creating session");
    const session = await client.newSession({
      cwd,
      mcpServers: [],
    });

    return {
      client,
      agent,
      sessionId: session.sessionId,
      closed,
      cancelPermissions: () => permissions.abort(),
    };
  } catch (error) {
    permissions.abort();
    await terminateAcpServer(agent);
    await closed;
    throw error;
  }
}

/** Runs until the interactive session and its owned server have closed. */
export async function runAcpClientInteractive(opts: AcpClientOptions = {}): Promise<number> {
  const { client, agent, sessionId, closed, cancelPermissions } = await createAcpClient(opts);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let quitting = false;
  let shutdown: Promise<void> | undefined;
  let promptTask: Promise<void> | undefined;
  let signalCode: number | undefined;
  const quit = () => {
    if (shutdown) {
      return shutdown;
    }
    quitting = true;
    // Readable schedules read-ahead after dispatching the data callback. Closing
    // readline inside that callback queues stdin's native readStop too early:
    // read-ahead can restart the pipe even though stdin is already paused.
    shutdown = Promise.resolve().then(async () => {
      cancelPermissions();
      rl.close();
      process.stdin.pause();
      if (!hasChildExited(agent)) {
        // Let the peer settle a prompt before closing its transport. Keep the
        // reader alive for final updates and the prompt's cancellation response.
        const activePrompt = promptTask;
        if (activePrompt) {
          await settlesWithin(
            client.cancel({ sessionId }).catch(() => {}),
            ACP_SERVER_KILL_GRACE_MS,
          );
          await settlesWithin(activePrompt, ACP_SERVER_KILL_GRACE_MS);
        }
        agent.stdin?.end();
        if (!(await waitForChildExit(agent, ACP_SERVER_KILL_GRACE_MS))) {
          await terminateAcpServer(agent);
        }
      }
      await closed;
    });
    return shutdown;
  };
  const onInputClose = () => {
    if (!quitting) {
      void quit();
    }
  };
  const onSigint = () => {
    signalCode = 130;
    void quit();
  };
  const onSigterm = () => {
    signalCode = 143;
    void quit();
  };
  rl.once("close", onInputClose);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const prompt = () => {
    if (quitting || hasChildExited(agent)) {
      return;
    }
    rl.question("> ", (input) => {
      const text = input.trim();
      if (!text) {
        prompt();
        return;
      }
      if (text === "exit" || text === "quit") {
        void quit();
        return;
      }
      promptTask = (async () => {
        try {
          const response = await client.prompt({ sessionId, prompt: [{ type: "text", text }] });
          console.log(`\n[${response.stopReason}]\n`);
        } catch (err) {
          console.error(`\n[error] ${String(err)}\n`);
        }
        promptTask = undefined;
        prompt();
      })();
    });
  };
  try {
    console.log("OpenClaw ACP client");
    console.log(`Session: ${sessionId}`);
    console.log('Type a prompt, or "exit" to quit.\n');
    prompt();
    await closed;
    const code = agent.exitCode ?? (quitting ? 0 : 1);
    console.log(
      `\nAgent exited with ${agent.signalCode ? `signal ${agent.signalCode}` : `code ${agent.exitCode}`}`,
    );
    return code !== 0 ? code : (signalCode ?? code);
  } finally {
    // Unexpected server exit takes the same cleanup path, without claiming a
    // successful client-owned cancellation for its exit status.
    await quit();
    await client.closed;
    await promptTask;
    rl.off("close", onInputClose);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
