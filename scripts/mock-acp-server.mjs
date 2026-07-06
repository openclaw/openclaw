/**
 * Minimal ACP protocol mock server for testing the ACP client.
 *
 * Speaks ACP JSON-RPC over ndjson stdin/stdout.
 * Sends a session/update notification that exercises printSessionUpdate.
 *
 * Used by: scripts/proof-99363-acp-client.mjs
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

let initialized = false;

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);

    // Handle initialize request
    if (msg.method === "initialize" && !initialized) {
      initialized = true;
      const response = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          serverCapabilities: {},
          serverInfo: { name: "mock-acp-server", version: "1.0.0" },
        },
      };
      process.stdout.write(JSON.stringify(response) + "\n");

      // Now send a session/update notification to exercise printSessionUpdate
      // This tests that Object.hasOwn correctly identifies the sessionUpdate discriminator

      // 1. agent_message_chunk with text → should write to stdout via printSessionUpdate
      const chunkNotification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-001",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "PROOF: ACP agent_message_chunk processed via Object.hasOwn guard",
            },
          },
        },
      };
      process.stdout.write(JSON.stringify(chunkNotification) + "\n");

      // 2. tool_call notification → should log tool info
      const toolNotification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-001",
          update: {
            sessionUpdate: "tool_call",
            title: "read_file",
            status: "in_progress",
            toolCallId: "tool_001",
          },
        },
      };
      process.stdout.write(JSON.stringify(toolNotification) + "\n");

      // 3. Non-session-update notification (no sessionUpdate property) → should be REJECTED by Object.hasOwn guard
      const nonUpdateNotification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-001",
          update: {
            someOtherField: "should be ignored",
          },
        },
      };
      process.stdout.write(JSON.stringify(nonUpdateNotification) + "\n");

      // Signal completion so the client knows to exit
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    }
  } catch {
    // ignore parse errors
  }
});

// Keep process alive until client disconnects
setTimeout(() => {
  process.exit(0);
}, 5000);
