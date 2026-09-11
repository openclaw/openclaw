#!/usr/bin/env node
import { createHash } from "node:crypto";
// Claude Code channel MCP server for OpenClaw live local sessions.
//
// Claude Code spawns this process (from `.mcp.json` / `claude mcp add`) and talks
// MCP over stdio. It connects to the OpenClaw node-host bridge socket and turns
// every `input` frame the bridge sends into a `notifications/claude/channel`
// event, so team messages from the Gateway reach the running session at its
// next turn boundary. The bridge learns which Claude session this process
// serves from the SessionStart hook (openclaw-channel-hook.mjs), matched by the
// Claude process that spawned both (ppid here, hook ancestry there), then cwd.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const RECONNECT_MS = 2_000;
const SERVER_NAME = "openclaw";

/** Mirror of the node-host endpoint resolution (state dir override, then ~/.openclaw). */
function resolveBridgeEndpoint(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const stateDir = override
    ? path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()))
    : path.join(os.homedir(), ".openclaw");
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\openclaw-claude-channel-${digest}`;
  }
  return path.join(stateDir, "node", "claude-channel.sock");
}

const endpoint = resolveBridgeEndpoint();

const mcp = new Server(
  { name: SERVER_NAME, version: "1.0.0" },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions:
      'Messages from your OpenClaw team arrive as <channel source="openclaw" sender="..." openclaw_input_id="...">. ' +
      "Treat them as instructions from a teammate who is watching this session live. " +
      "Your normal replies are already visible to the team; call the reply tool only to send a short, explicit answer to the sender.",
  },
);

let bridge = null;
let bridgeReady = false;

function writeBridge(frame) {
  if (bridge && !bridge.destroyed && bridgeReady) {
    bridge.write(`${JSON.stringify(frame)}\n`);
    return true;
  }
  return false;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a short message back to the OpenClaw team member who messaged this session",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message to send" },
          openclaw_input_id: {
            type: "string",
            description: "The openclaw_input_id attribute of the channel message being answered",
          },
        },
        required: ["text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "reply") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  const args = request.params.arguments ?? {};
  const delivered = writeBridge({
    type: "reply",
    text: typeof args.text === "string" ? args.text : "",
    ...(typeof args.openclaw_input_id === "string" ? { inputId: args.openclaw_input_id } : {}),
  });
  // The reply is already in the transcript OpenClaw tails; the bridge only needs the ack.
  return {
    content: [
      {
        type: "text",
        text: delivered
          ? "sent"
          : "OpenClaw bridge is not connected; the team still sees this transcript",
      },
    ],
  };
});

async function handleBridgeFrame(frame) {
  if (frame.type !== "input" || typeof frame.inputId !== "string") {
    return;
  }
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: typeof frame.content === "string" ? frame.content : "",
        meta: frame.meta && typeof frame.meta === "object" ? frame.meta : {},
      },
    });
    writeBridge({ type: "delivered", inputId: frame.inputId });
  } catch (error) {
    writeBridge({
      type: "failed",
      inputId: frame.inputId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function connectBridge() {
  const socket = net.createConnection(endpoint);
  bridge = socket;
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    bridgeReady = true;
    socket.write(
      `${JSON.stringify({ type: "hello", cwd: process.cwd(), pid: process.pid, ppid: process.ppid })}\n`,
    );
  });
  socket.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }
      try {
        void handleBridgeFrame(JSON.parse(line));
      } catch {
        // Malformed bridge line; keep the connection.
      }
    }
  });
  const retry = () => {
    bridgeReady = false;
    if (bridge === socket) {
      bridge = null;
      setTimeout(connectBridge, RECONNECT_MS).unref();
    }
  };
  socket.on("error", () => socket.destroy());
  socket.on("close", retry);
}

await mcp.connect(new StdioServerTransport());
connectBridge();
