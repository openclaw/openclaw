/** Interactive stdio ACP client used to connect a terminal session to an OpenClaw ACP server. */
import { spawn, type ChildProcess } from "node:child_process";
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
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import {
  shouldDetachChildForProcessTree,
  signalChildProcessTree,
} from "../process/child-process-tree.js";
import { killProcessTree } from "../process/kill-tree.js";
import {
  buildAcpClientStripKeys,
  resolveAcpClientSpawnEnv,
  resolveAcpClientSpawnInvocation,
  resolvePermissionRequest,
  shouldStripProviderAuthEnvVarsForAcpServer,
} from "./client-helpers.js";

type AcpClientOptions = {
  cwd?: string;
  serverCommand?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  setupTimeoutMs?: number;
  verbose?: boolean;
};

type AcpClientHandle = {
  client: ClientSideConnection;
  agent: ChildProcess;
  sessionId: string;
};

const ACP_CLIENT_SETUP_TIMEOUT_MS = 30_000;
const ACP_CLIENT_TERMINATION_GRACE_MS = 500;
const ACP_CLIENT_FORCE_KILL_WAIT_MS = 500;

type AcpClientSetupPhase = "initialization" | "session creation";

function isAgentRunning(agent: ChildProcess): boolean {
  return agent.exitCode === null && agent.signalCode === null;
}

function waitForAgentClose(agent: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isAgentRunning(agent)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      agent.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    agent.once("close", finish);
  });
}

async function terminateAcpAgent(agent: ChildProcess): Promise<void> {
  if (!isAgentRunning(agent)) {
    return;
  }

  try {
    agent.stdin?.end();
  } catch {
    // Best-effort pipe cleanup before terminating the owned process tree.
  }

  if (agent.pid) {
    killProcessTree(agent.pid, {
      graceMs: ACP_CLIENT_TERMINATION_GRACE_MS,
      detached: shouldDetachChildForProcessTree(),
    });
  } else {
    agent.kill("SIGTERM");
  }

  await waitForAgentClose(agent, ACP_CLIENT_TERMINATION_GRACE_MS + ACP_CLIENT_FORCE_KILL_WAIT_MS);
  if (isAgentRunning(agent)) {
    signalChildProcessTree(agent, "SIGKILL");
    await waitForAgentClose(agent, ACP_CLIENT_FORCE_KILL_WAIT_MS);
  }
}

function toArgs(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildServerArgs(opts: AcpClientOptions): string[] {
  const args = ["acp", ...toArgs(opts.serverArgs)];
  if (opts.serverVerbose && !args.includes("--verbose") && !args.includes("-v")) {
    args.push("--verbose");
  }
  return args;
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

async function createAcpClient(opts: AcpClientOptions = {}): Promise<AcpClientHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const verbose = Boolean(opts.verbose);
  const log = verbose ? (msg: string) => console.error(`[acp-client] ${msg}`) : () => {};

  ensureOpenClawCliOnPath();
  const serverArgs = buildServerArgs(opts);

  const entryPath = resolveSelfEntryPath();
  const defaultServerCommand = entryPath ? process.execPath : "openclaw";
  const defaultServerArgs = entryPath ? [entryPath, ...serverArgs] : serverArgs;
  const serverCommand = opts.serverCommand ?? defaultServerCommand;
  const effectiveArgs = opts.serverCommand || !entryPath ? serverArgs : defaultServerArgs;
  const { getActiveSkillEnvKeys } = await import("../skills/runtime/env-overrides.runtime.js");
  const stripProviderAuthEnvVars = shouldStripProviderAuthEnvVarsForAcpServer({
    serverCommand,
    serverArgs: effectiveArgs,
    defaultServerCommand,
    defaultServerArgs,
  });
  const stripKeys = buildAcpClientStripKeys({
    stripProviderAuthEnvVars,
    activeSkillEnvKeys: getActiveSkillEnvKeys(),
  });
  const spawnEnv = resolveAcpClientSpawnEnv(process.env, { stripKeys });
  const spawnInvocation = resolveAcpClientSpawnInvocation(
    { serverCommand, serverArgs: effectiveArgs },
    {
      platform: process.platform,
      env: spawnEnv,
      execPath: process.execPath,
    },
  );

  log(`spawning: ${spawnInvocation.command} ${spawnInvocation.args.join(" ")}`);

  const agent = spawn(spawnInvocation.command, spawnInvocation.args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    detached: shouldDetachChildForProcessTree(),
    env: spawnEnv,
    shell: spawnInvocation.shell,
    windowsHide: spawnInvocation.windowsHide,
  });

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
      requestPermission: async (params: RequestPermissionRequest) => {
        return resolvePermissionRequest(params, { cwd });
      },
    }),
    stream,
  );

  const setupTimeoutMs = opts.setupTimeoutMs ?? ACP_CLIENT_SETUP_TIMEOUT_MS;
  let setupPhase: AcpClientSetupPhase = "initialization";
  let setupTimer: NodeJS.Timeout | undefined;
  try {
    // One deadline covers both setup RPCs so a slow initialize cannot consume a fresh
    // full timeout before session creation. Closing the child is required because the
    // ACP SDK's request cancellation remains cooperative when a peer stops responding.
    const setupTimeout = new Promise<never>((_resolve, reject) => {
      setupTimer = setTimeout(() => {
        reject(
          new Error(
            `ACP client setup timed out during ${setupPhase} after ${String(setupTimeoutMs)}ms`,
          ),
        );
      }, setupTimeoutMs);
    });
    const setup = (async () => {
      log("initializing");
      await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "openclaw-acp-client", version: "1.0.0" },
      });

      setupPhase = "session creation";
      log("creating session");
      return await client.newSession({
        cwd,
        mcpServers: [],
      });
    })();
    // Terminating a timed-out agent rejects the still-pending SDK request after the race settles.
    void setup.catch(() => {});

    const session = await Promise.race([setup, setupTimeout]);

    return {
      client,
      agent,
      sessionId: session.sessionId,
    };
  } catch (err) {
    await terminateAcpAgent(agent).catch((cleanupErr: unknown) => {
      log(`setup cleanup failed: ${String(cleanupErr)}`);
    });
    throw err;
  } finally {
    if (setupTimer) {
      clearTimeout(setupTimer);
    }
  }
}

/** Starts the terminal prompt loop for a local ACP client session. */
export async function runAcpClientInteractive(opts: AcpClientOptions = {}): Promise<void> {
  const { client, agent, sessionId } = await createAcpClient(opts);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // The server runs in its own process group so setup failures can terminate descendants.
  // Handle terminal shutdown while the event loop is live; Windows tree cleanup starts taskkill.
  const shutdownSignals = [
    { signal: "SIGHUP", exitCode: 129 },
    { signal: "SIGINT", exitCode: 130 },
    { signal: "SIGTERM", exitCode: 143 },
  ] as const;
  const shutdownHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  const removeShutdownHandlers = () => {
    for (const { signal, handler } of shutdownHandlers) {
      process.off(signal, handler);
    }
  };
  for (const { signal, exitCode } of shutdownSignals) {
    const handler = () => {
      removeShutdownHandlers();
      signalChildProcessTree(agent, "SIGTERM");
      rl.close();
      process.exit(exitCode);
    };
    process.once(signal, handler);
    shutdownHandlers.push({ signal, handler });
  }
  agent.once("exit", removeShutdownHandlers);

  console.log("OpenClaw ACP client");
  console.log(`Session: ${sessionId}`);
  console.log('Type a prompt, or "exit" to quit.\n');

  const prompt = () => {
    rl.question("> ", (input) => {
      void (async () => {
        const text = input.trim();
        if (!text) {
          prompt();
          return;
        }
        if (text === "exit" || text === "quit") {
          removeShutdownHandlers();
          signalChildProcessTree(agent, "SIGTERM");
          rl.close();
          process.exit(0);
        }

        try {
          const response = await client.prompt({
            sessionId,
            prompt: [{ type: "text", text }],
          });
          console.log(`\n[${response.stopReason}]\n`);
        } catch (err) {
          console.error(`\n[error] ${String(err)}\n`);
        }

        prompt();
      })();
    });
  };

  prompt();

  agent.on("exit", (code) => {
    console.log(`\nAgent exited with code ${code ?? 0}`);
    rl.close();
    process.exit(code ?? 0);
  });
}
