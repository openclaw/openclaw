#!/usr/bin/env node
/**
 * ACP Client CLI
 *
 * Simple test client for the Clawd ACP server.
 * Spawns clawd-acp and communicates via stdio JSON-RPC.
 *
 * Usage:
 *   clawd-acp-client [--cwd <dir>] [--agent <path>]
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

export type AcpClientOptions = {
  /** Working directory for the session */
  cwd?: string;
  /** Path to agent binary (default: clawd-acp) */
  agentPath?: string;
  /** Agent arguments */
  agentArgs?: string[];
  /** Verbose logging */
  verbose?: boolean;
};

/**
 * Spawn the agent and create a client connection.
 */
export async function createAcpClient(opts: AcpClientOptions = {}): Promise<{
  client: ClientSideConnection;
  agent: ChildProcess;
  sessionId: string;
}> {
  const cwd = opts.cwd ?? process.cwd();
  const agentPath = opts.agentPath ?? "clawd-acp";
  const agentArgs = opts.agentArgs ?? [];
  const verbose = opts.verbose ?? false;

  const log = verbose
    ? (msg: string) => console.error(`[client] ${msg}`)
    : () => {};

  log(`spawning agent: ${agentPath} ${agentArgs.join(" ")}`);

  // Spawn the agent process
  const agent = spawn(agentPath, agentArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
  });

  if (!agent.stdin || !agent.stdout) {
    throw new Error("Failed to create agent stdio pipes");
  }

  // Create streams for the SDK
  const input = Writable.toWeb(agent.stdin);
  const output = Readable.toWeb(agent.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  // Track session updates
  const updates: SessionNotification[] = [];

  // Create client connection
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params: SessionNotification) => {
        updates.push(params);
        printSessionUpdate(params);
      },
      requestPermission: async (params) => {
        // Auto-approve for testing
        console.log("\n[permission requested]", params.toolCall?.title);
        const allowOption = params.options.find(
          (o: { kind: string; optionId: string }) => o.kind === "allow_once",
        );
        return {
          outcome: {
            outcome: "selected",
            optionId:
              allowOption?.optionId ?? params.options[0]?.optionId ?? "allow",
          },
        };
      },
    }),
    stream,
  );

  log("initializing...");

  // Initialize
  const initResponse = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "clawd-acp-client", version: "1.0.0" },
  });

  log(
    `initialized: protocol=${initResponse.protocolVersion}, agent=${initResponse.agentInfo?.name}`,
  );

  // Create session
  const sessionResponse = await client.newSession({
    cwd,
    mcpServers: [],
  });

  log(`session created: ${sessionResponse.sessionId}`);

  return {
    client,
    agent,
    sessionId: sessionResponse.sessionId,
  };
}

/**
 * Print a session update to stdout.
 */
function printSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;

  if ("sessionUpdate" in update) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") {
          process.stdout.write(update.content.text);
        }
        break;
      case "tool_call":
        console.log(`\n[tool] ${update.title} (${update.status})`);
        break;
      case "tool_call_update":
        if (update.status) {
          console.log(`[tool update] ${update.toolCallId}: ${update.status}`);
        }
        break;
      default:
        // Other update types
        break;
    }
  }
}

/**
 * Run interactive prompt loop.
 */
async function runInteractive(opts: AcpClientOptions): Promise<void> {
  const { client, agent, sessionId } = await createAcpClient(opts);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Clawd ACP Client");
  console.log(`Session: ${sessionId}`);
  console.log('Type your prompts, or "exit" to quit.\n');

  const prompt = (): void => {
    rl.question("> ", async (input) => {
      const text = input.trim();

      if (text === "exit" || text === "quit") {
        console.log("Goodbye!");
        agent.kill();
        rl.close();
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        const response = await client.prompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });
        console.log(`\n[${response.stopReason}]\n`);
      } catch (err) {
        console.error(`\n[error] ${err}\n`);
      }

      prompt();
    });
  };

  prompt();

  // Handle agent exit
  agent.on("exit", (code) => {
    console.log(`\nAgent exited with code ${code}`);
    rl.close();
    process.exit(code ?? 0);
  });
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts: AcpClientOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cwd" && args[i + 1]) {
      opts.cwd = args[++i];
    } else if (arg === "--agent" && args[i + 1]) {
      // Support "node dist/acp/server.js" as a single quoted arg
      const agentArg = args[++i];
      const parts = agentArg.split(" ");
      opts.agentPath = parts[0];
      opts.agentArgs = parts.slice(1);
    } else if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: clawd-acp-client [options]

Test client for the Clawd ACP server.

Options:
  --cwd <dir>      Working directory (default: current directory)
  --agent <path>   Path to agent binary (default: clawd-acp)
  --verbose, -v    Enable verbose logging
  --help, -h       Show this help message
`);
      process.exit(0);
    }
  }

  await runInteractive(opts);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
