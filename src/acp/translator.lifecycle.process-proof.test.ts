/**
 * Cross-process NDJSON wire ordering proof for newSession/resumeSession.
 *
 * Spawns a real ACP server child process that imports AcpGatewayAgent +
 * AgentSideConnection + ndJsonStream over real stdio pipes. The parent
 * process acts as a real ACP client, sending JSON-RPC requests via stdin
 * and capturing raw NDJSON bytes from the child's stdout.
 *
 * This is NOT in-process proof: the server runs as a separate Node process
 * with real stdio pipes between client and server. The captured transcript
 * is the exact bytes that cross the process boundary.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROOF_SCRIPT_PATH = path.join(import.meta.dirname, "acp-server-process-for-proof.ts");

async function spawnAcpServerAndCapture(opts: {
  sessionsListResponse: "empty" | "with-session";
  resumeSessionKey?: string;
}): Promise<{
  childStdoutChunks: Buffer[];
  childExit: Promise<void>;
  sendLine: (line: string) => Promise<void>;
  close: () => void;
}> {
  const chunks: Buffer[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", PROOF_SCRIPT_PATH], {
    env: {
      ...process.env,
      PROOF_MODE: opts.sessionsListResponse === "with-session" ? "resume" : "new",
      PROOF_SESSION_KEY: opts.resumeSessionKey ?? "",
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR ?? "",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const childExit = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ACP server exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  let writeQueue: Promise<void> = Promise.resolve();
  const sendLine = async (line: string): Promise<void> => {
    writeQueue = writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(line + "\n", (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
    );
    await writeQueue;
  };

  return {
    childStdoutChunks: chunks,
    childExit,
    sendLine,
    close: () => {
      child.stdin.end();
    },
  };
}

async function waitForNdjsonLine(
  chunks: Buffer[],
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const text = Buffer.concat(chunks).toString("utf-8");
    const lines = text.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (predicate(msg)) {
          return i;
        }
      } catch {
        // skip unparseable
      }
    }
  }
  return -1;
}

function getAllNdjsonLines(chunks: Buffer[]): string[] {
  const text = Buffer.concat(chunks).toString("utf-8");
  return text.split("\n").filter(Boolean);
}

describe("acp translator cross-process ndjson ordering proof", () => {
  it("newSession: response line precedes session/update notification across process boundary", async () => {
    const { childStdoutChunks, childExit, sendLine, close } = await spawnAcpServerAndCapture({
      sessionsListResponse: "empty",
    });

    try {
      // Send initialize
      await sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "cross-process-proof-client", version: "1.0.0" },
          },
        }),
      );

      // Wait for initialize response
      await waitForNdjsonLine(childStdoutChunks, (msg) => msg.id === 1);

      // Send session/new
      await sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: "/tmp", mcpServers: [], _meta: {} },
        }),
      );

      // Wait for session/new response
      const responseIdx = await waitForNdjsonLine(childStdoutChunks, (msg) => msg.id === 2);
      expect(responseIdx).toBeGreaterThanOrEqual(0);

      // Wait for session/update notification to arrive
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      const lines = getAllNdjsonLines(childStdoutChunks);
      let responseLineIndex = -1;
      let notificationLineIndex = -1;
      lines.forEach((line, i) => {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === 2) {
            responseLineIndex = i;
          }
          if (
            msg.method === "session/update" &&
            typeof msg.params === "object" &&
            msg.params !== null &&
            typeof (msg.params as Record<string, unknown>).update === "object"
          ) {
            if (notificationLineIndex === -1) {
              notificationLineIndex = i;
            }
          }
        } catch {
          // skip
        }
      });

      expect(responseLineIndex).toBeGreaterThanOrEqual(0);
      expect(notificationLineIndex).toBeGreaterThanOrEqual(0);
      expect(responseLineIndex).toBeLessThan(notificationLineIndex);

      // Print captured transcript for PR evidence
      console.log("=== Cross-Process NDJSON transcript (newSession) ===");
      lines.forEach((line, i) => {
        console.log(`  [${i}] ${line}`);
      });
    } finally {
      close();
      await childExit.catch(() => {});
    }
  });

  it("resumeSession: response line precedes session/update notification across process boundary", async () => {
    const { childStdoutChunks, childExit, sendLine, close } = await spawnAcpServerAndCapture({
      sessionsListResponse: "with-session",
      resumeSessionKey: "agent:main:process-proof",
    });

    try {
      await sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "cross-process-proof-client", version: "1.0.0" },
          },
        }),
      );
      await waitForNdjsonLine(childStdoutChunks, (msg) => msg.id === 1);

      await sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/resume",
          params: {
            sessionId: "agent:main:process-proof",
            cwd: "/tmp",
            mcpServers: [],
            _meta: {},
          },
        }),
      );

      const responseIdx = await waitForNdjsonLine(childStdoutChunks, (msg) => msg.id === 2);
      expect(responseIdx).toBeGreaterThanOrEqual(0);

      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      const lines = getAllNdjsonLines(childStdoutChunks);
      let responseLineIndex = -1;
      let notificationLineIndex = -1;
      lines.forEach((line, i) => {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === 2) {
            responseLineIndex = i;
          }
          if (
            msg.method === "session/update" &&
            typeof msg.params === "object" &&
            msg.params !== null &&
            typeof (msg.params as Record<string, unknown>).update === "object"
          ) {
            if (notificationLineIndex === -1) {
              notificationLineIndex = i;
            }
          }
        } catch {
          // skip
        }
      });

      expect(responseLineIndex).toBeGreaterThanOrEqual(0);
      expect(notificationLineIndex).toBeGreaterThanOrEqual(0);
      expect(responseLineIndex).toBeLessThan(notificationLineIndex);

      console.log("=== Cross-Process NDJSON transcript (resumeSession) ===");
      lines.forEach((line, i) => {
        console.log(`  [${i}] ${line}`);
      });
    } finally {
      close();
      await childExit.catch(() => {});
    }
  });
});
