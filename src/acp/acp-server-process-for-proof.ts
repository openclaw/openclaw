/**
 * Minimal ACP server process for cross-process NDJSON proof.
 *
 * This script runs as a real Node child process. It imports AcpGatewayAgent
 * + AgentSideConnection + ndJsonStream + real stdio pipes, so the NDJSON
 * bytes that flow through process.stdout are the exact wire bytes a real
 * ACP client would receive.
 *
 * The Gateway client is mocked in-process (no real Gateway connection), but
 * the ACP transport is fully real: real ndJsonStream serialization, real
 * stdio pipes, real process boundary between client and server.
 */
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import type { GatewayClient } from "../gateway/client.js";
import { AcpGatewayAgent } from "./translator.js";

const mode = process.env.PROOF_MODE === "resume" ? "resume" : "new";
const resumeSessionKey = process.env.PROOF_SESSION_KEY || "";

// Mock Gateway client — matches the shape AcpGatewayAgent expects.
const gateway = {
  request: async (method: string, _params?: Record<string, unknown>) => {
    if (method === "sessions.list") {
      if (mode === "resume") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          totalCount: 1,
          limitApplied: 1,
          hasMore: false,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: resumeSessionKey,
              kind: "direct",
              spawnedWorkspaceDir: "/tmp",
              derivedTitle: "Process proof session",
              updatedAt: Date.now(),
              thinkingLevel: "adaptive",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      return {
        ts: Date.now(),
        path: "/tmp/sessions.json",
        count: 0,
        totalCount: 0,
        limitApplied: 0,
        hasMore: false,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      };
    }
    if (method === "sessions.get") {
      return { ok: true };
    }
    return { ok: true };
  },
} as unknown as GatewayClient;

const sessionStore = createInMemorySessionStore();

// Real stdio pipes + real ndJsonStream serialization.
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);

const conn = new AgentSideConnection((connection: AgentSideConnection) => {
  const agent = new AcpGatewayAgent(connection, gateway, { sessionStore });
  return agent;
}, stream);

// Keep the process alive waiting for ACP requests.
// Connection closes automatically when stdin closes.
void conn;
void PROTOCOL_VERSION;

process.on("SIGTERM", () => {
  sessionStore.clearAllSessionsForTest();
  process.exit(0);
});

process.on("SIGINT", () => {
  sessionStore.clearAllSessionsForTest();
  process.exit(0);
});
