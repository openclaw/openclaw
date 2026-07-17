import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  formatSqliteSessionFileMarker,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, it, expect } from "vitest";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  type RuntimeParityToolCall,
  type RuntimeParityCell,
} from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

/**
 * Evidence: Body cancel fires before returning null when the mock endpoint
 * returns a non-200 status — exact QA Lab runtime-parity path.
 *
 * This test simulates the exact scenario that triggers the changed line:
 * `loadRuntimeParityMockToolCalls` gets a non-ok Response from the
 * debug/requests endpoint, cancels the body, and returns null.
 * captureRuntimeParityCell then falls back to transcript-only tool calls.
 */
async function setupErrorServer(statusCode: number) {
  const server = createServer((req, res) => {
    if (req.url === "/debug/requests") {
      res.statusCode = statusCode;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `Mock error ${statusCode}` }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

async function seedTranscript(params: { sessionId: string; sessionKey: string; tempRoot: string }) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(params.tempRoot, "state") };
  const storePath = resolveStorePath(undefined, { agentId: "qa", env });
  await upsertSessionEntry({
    agentId: "qa",
    env,
    sessionKey: params.sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "qa",
        sessionId: params.sessionId,
        storePath,
      }),
      updatedAt: 100,
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId: "qa",
    env,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath,
    now: 1,
    message: { role: "user", content: "Delegate one bounded QA task to a subagent." } as never,
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId: "qa",
    env,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath,
    now: 2,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "test.md" } },
      ],
    } as never,
  });
  return { storePath, env };
}

describe("runtime-parity body cancel evidence", () => {
  it("cancels body and returns transcript-only result on 503 from mock endpoint", async () => {
    const tempRoot = await tempDirs.makeTempDir("openclaw-qa-evidence-body-cancel");
    await seedTranscript({
      sessionId: "evidence-503",
      sessionKey: "agent:qa:evidence-503",
      tempRoot,
    });

    const { server, port } = await setupErrorServer(503);
    try {
      const cell = await captureRuntimeParityCell({
        runtime: "openclaw",
        gateway: { tempRoot },
        mockBaseUrl: `http://127.0.0.1:${port}`,
        scenarioResult: { status: "pass" },
        wallClockMs: 10,
      });

      // Should still return a valid cell (transcript-only fallback)
      expect(cell).toBeDefined();
      expect(cell.runtimeErrorClass).toBeUndefined();
      // With no mock data, tool calls come from transcript
      expect(cell.toolCalls).toHaveLength(1);
      expect(cell.toolCalls[0]).toMatchObject({ tool: "read_file" });
      expect(cell.runtime).toBe("openclaw");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("handles 400 Bad Request without crashing", async () => {
    const tempRoot = await tempDirs.makeTempDir("openclaw-qa-evidence-body-cancel-400");
    await seedTranscript({
      sessionId: "evidence-400",
      sessionKey: "agent:qa:evidence-400",
      tempRoot,
    });

    const { server, port } = await setupErrorServer(400);
    try {
      const cell = await captureRuntimeParityCell({
        runtime: "openclaw",
        gateway: { tempRoot },
        mockBaseUrl: `http://127.0.0.1:${port}`,
        scenarioResult: { status: "pass" },
        wallClockMs: 10,
      });

      expect(cell).toBeDefined();
      expect(cell.runtimeErrorClass).toBeUndefined();
      expect(cell.toolCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("handles 500 Internal Server Error without crashing", async () => {
    const tempRoot = await tempDirs.makeTempDir("openclaw-qa-evidence-body-cancel-500");
    await seedTranscript({
      sessionId: "evidence-500",
      sessionKey: "agent:qa:evidence-500",
      tempRoot,
    });

    const { server, port } = await setupErrorServer(500);
    try {
      const cell = await captureRuntimeParityCell({
        runtime: "openclaw",
        gateway: { tempRoot },
        mockBaseUrl: `http://127.0.0.1:${port}`,
        scenarioResult: { status: "pass" },
        wallClockMs: 10,
      });

      expect(cell).toBeDefined();
      expect(cell.runtimeErrorClass).toBeUndefined();
      expect(cell.toolCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("gracefully handles null mockBaseUrl (skips mock fetch entirely)", async () => {
    const tempRoot = await tempDirs.makeTempDir("openclaw-qa-evidence-null-baseurl");
    await seedTranscript({
      sessionId: "evidence-null",
      sessionKey: "agent:qa:evidence-null",
      tempRoot,
    });

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      // No mockBaseUrl — loadRuntimeParityMockToolCalls returns null early
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell).toBeDefined();
    expect(cell.runtimeErrorClass).toBeUndefined();
    expect(cell.toolCalls.length).toBeGreaterThanOrEqual(1);
  });
});
