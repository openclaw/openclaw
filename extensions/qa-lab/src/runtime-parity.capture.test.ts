// Qa Lab tests cover runtime parity capture behavior against a real mock endpoint.
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await tempDirs.cleanup();
});

async function writeRuntimeParityTranscript(tempRoot: string) {
  const sessionsDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:qa:runtime-parity:oversized-debug": {
        sessionId: "runtime-parity-oversized-debug",
        sessionFile: "runtime-parity-oversized-debug.jsonl",
        updatedAt: Date.now(),
      },
    }),
    "utf8",
  );
  const rows = [
    {
      message: {
        role: "user",
        content: "parent prompt",
      },
    },
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-readme",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
    },
    {
      message: {
        role: "tool",
        toolName: "read_file",
        tool_call_id: "call-readme",
        content: "README contents from transcript",
      },
    },
    {
      message: {
        role: "assistant",
        content: "done",
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          totalTokens: 3,
        },
      },
    },
  ];
  await fs.writeFile(
    path.join(sessionsDir, "runtime-parity-oversized-debug.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n"),
    "utf8",
  );
}

async function startOversizedDebugServer() {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  let chunksWritten = 0;
  let debugRequests = 0;
  let debugResponseClosedResolve: (() => void) | undefined;
  const debugResponseClosed = new Promise<void>((resolve) => {
    debugResponseClosedResolve = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url !== "/debug/requests") {
      response.writeHead(404);
      response.end();
      return;
    }
    debugRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => {
      if (response.destroyed) {
        clearInterval(timer);
        return;
      }
      chunksWritten += 1;
      response.write(chunk);
    }, 5);
    response.on("close", () => {
      clearInterval(timer);
      debugResponseClosedResolve?.();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getDebugRequests: () => debugRequests,
    getChunksWritten: () => chunksWritten,
    waitForDebugResponseClose: async () => {
      await Promise.race([
        debugResponseClosed,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for debug response close")), 1000);
        }),
      ]);
    },
  };
}

describe("runtime parity capture", () => {
  it("falls back to transcripts when a real mock debug endpoint returns an oversized snapshot", async () => {
    const tempRoot = await tempDirs.makeTempDir("runtime-parity-capture-");
    await writeRuntimeParityTranscript(tempRoot);
    const debugServer = await startOversizedDebugServer();

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: {
        tempRoot,
        logs: () => "",
      },
      scenarioResult: { status: "pass" },
      wallClockMs: 12,
      mockBaseUrl: debugServer.baseUrl,
    });

    expect(debugServer.getDebugRequests()).toBe(1);
    expect(debugServer.getChunksWritten()).toBeGreaterThan(0);
    await debugServer.waitForDebugResponseClose();
    expect(cell.finalText).toBe("done");
    expect(cell.toolCalls).toEqual([
      {
        tool: "read_file",
        argsHash: expect.any(String),
        resultHash: expect.any(String),
      },
    ]);
  });
});
