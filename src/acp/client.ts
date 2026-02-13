import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";

/**
 * Tools that require explicit user approval in ACP sessions.
 * These tools can execute arbitrary code, modify the filesystem,
 * or access sensitive resources.
 */
const DANGEROUS_ACP_TOOLS = new Set([
  "exec",
  "spawn",
  "shell",
  "sessions_spawn",
  "sessions_send",
  "gateway",
  "fs_write",
  "fs_delete",
  "fs_move",
  "apply_patch",
]);

function promptUserPermission(toolName: string, toolTitle?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName}`);
      rl.close();
      resolve(false);
    }, 30_000);

    const label = toolTitle ? `${toolTitle} (${toolName})` : toolName;
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      clearTimeout(timeout);
      rl.close();
      const approved = answer.trim().toLowerCase() === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName}`);
      resolve(approved);
    });
  });
}

export type AcpClientOptions = {
  cwd?: string;
  serverCommand?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  verbose?: boolean;
};

export type AcpClientHandle = {
  client: ClientSideConnection;
  agent: ChildProcess;
  sessionId: string;
};

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

function printSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;
  if (!("sessionUpdate" in update)) {
    return;
  }

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
      return;
    }
    default:
      return;
  }
}

export async function createAcpClient(opts: AcpClientOptions = {}): Promise<AcpClientHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const verbose = Boolean(opts.verbose);
  const log = verbose ? (msg: string) => console.error(`[acp-client] ${msg}`) : () => {};

  ensureOpenClawCliOnPath({ cwd });
  const serverCommand = opts.serverCommand ?? "openclaw";
  const serverArgs = buildServerArgs(opts);

  log(`spawning: ${serverCommand} ${serverArgs.join(" ")}`);

  const agent = spawn(serverCommand, serverArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
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
        // toolCall may include a `name` field not in the SDK type
        const toolCall = params.toolCall as Record<string, unknown> | undefined;
        const toolName = (typeof toolCall?.name === "string" ? toolCall.name : "") as string;
        const toolTitle = (params.toolCall?.title ?? "tool") as string;
        const options = params.options ?? [];
        const allowOnce = options.find((o) => o.kind === "allow_once");
        const rejectOption = options.find((o) => o.kind === "reject_once");

        // No options available — deny by default (fixes empty-options exploit)
        if (options.length === 0) {
          console.error(`[permission denied] ${toolName}: no options available`);
          return { outcome: { outcome: "selected", optionId: "deny" } };
        }

        // Safe tools: auto-approve (backward compatible)
        if (!DANGEROUS_ACP_TOOLS.has(toolName)) {
          console.error(`[permission auto-approved] ${toolName}`);
          return {
            outcome: {
              outcome: "selected",
              optionId: allowOnce?.optionId ?? options[0]?.optionId ?? "allow",
            },
          };
        }

        // Dangerous tools: require interactive confirmation
        console.error(`\n[permission requested] ${toolTitle} (${toolName})`);
        const approved = await promptUserPermission(toolName, toolTitle);

        if (approved && allowOnce) {
          return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
        }

        // Denied — use reject option if available, otherwise reject
        const rejectId = rejectOption?.optionId ?? "deny";
        return { outcome: { outcome: "selected", optionId: rejectId } };
      },
    }),
    stream,
  );

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
  };
}

export async function runAcpClientInteractive(opts: AcpClientOptions = {}): Promise<void> {
  const { client, agent, sessionId } = await createAcpClient(opts);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("OpenClaw ACP client");
  console.log(`Session: ${sessionId}`);
  console.log('Type a prompt, or "exit" to quit.\n');

  const prompt = () => {
    rl.question("> ", async (input) => {
      const text = input.trim();
      if (!text) {
        prompt();
        return;
      }
      if (text === "exit" || text === "quit") {
        agent.kill();
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
    });
  };

  prompt();

  agent.on("exit", (code) => {
    console.log(`\nAgent exited with code ${code ?? 0}`);
    rl.close();
    process.exit(code ?? 0);
  });
}
