import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OVSessionBridgeConfig } from "../src/config.js";
import { flushSessionToOV } from "../src/flush.js";
import { saveCheckpoint } from "../src/state.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ov-flush-test-"));
}

function writeTranscript(filePath: string, turns: { role: string; content: string }[]): void {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00Z" }),
    ...turns.map((t) =>
      JSON.stringify({ type: "message", message: { role: t.role, content: t.content } }),
    ),
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

function makeConfig(overrides: Partial<OVSessionBridgeConfig> = {}): OVSessionBridgeConfig {
  return {
    enabled: true,
    baseUrl: "http://localhost:1933",
    apiKey: "",
    agentId: "test-agent",
    timeoutMs: 5000,
    flushTimeoutMs: 10000,
    stateDir: "", // set per-test
    commitOnFlush: true,
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("flushSessionToOV", () => {
  let tmpDir: string;
  let cfg: OVSessionBridgeConfig;

  // We mock fetch globally so no real HTTP calls are made.
  const fetchMock = vi.fn();

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cfg = makeConfig({ stateDir: tmpDir });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function mockOvSuccess(ovSessionId: string): void {
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const method = opts.method ?? "GET";
      const u = String(url);

      if (u.endsWith("/health") || u.includes("/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }
      if (u.endsWith("/api/v1/sessions") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok", result: { session_id: ovSessionId } }),
        });
      }
      if (u.includes("/messages") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ok",
              result: { session_id: ovSessionId, message_count: 1 },
            }),
        });
      }
      if (u.includes("/commit") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok", result: {} }),
        });
      }
      return Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({
            status: "error",
            error: { message: `unexpected call: ${method} ${u}` },
          }),
      });
    });
  }

  it("skips when plugin is disabled", async () => {
    const result = await flushSessionToOV({
      openclawSessionId: "s1",
      sessionKey: "k1",
      agentId: "main",
      cfg: makeConfig({ enabled: false, stateDir: tmpDir }),
      isFinalFlush: true,
    });
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips already-finalized sessions (idempotency)", async () => {
    saveCheckpoint(tmpDir, {
      openclawSessionId: "s-fin",
      sessionKey: "k",
      agentId: "main",
      ovSessionId: "ov-fin",
      lastFlushedIndex: 3,
      finalized: true,
      updatedAt: new Date().toISOString(),
    });

    const result = await flushSessionToOV({
      openclawSessionId: "s-fin",
      sessionKey: "k",
      agentId: "main",
      cfg,
      isFinalFlush: true,
    });

    expect(result.skipped).toBe(true);
    expect(result.finalized).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates OV session, flushes turns, and commits on final flush", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "Hello OV" },
      { role: "assistant", content: "Hello back" },
    ]);
    mockOvSuccess("ov-new-session");

    const result = await flushSessionToOV({
      openclawSessionId: "s2",
      sessionKey: "k2",
      agentId: "main",
      sessionFile,
      cfg,
      isFinalFlush: true,
    });

    expect(result.ok).toBe(true);
    expect(result.turnsFlushed).toBe(2);
    expect(result.finalized).toBe(true);
    expect(result.ovSessionId).toBe("ov-new-session");

    // Verify checkpoint was saved.
    const { loadCheckpoint } = await import("../src/state.js");
    const cp = loadCheckpoint(tmpDir, "s2");
    expect(cp?.finalized).toBe(true);
    expect(cp?.lastFlushedIndex).toBe(2);
    expect(cp?.ovSessionId).toBe("ov-new-session");
  });

  it("incremental flush: only sends new turns since last checkpoint", async () => {
    const sessionFile = path.join(tmpDir, "session-inc.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Turn 2" },
      { role: "user", content: "Turn 3" },
    ]);

    // Pre-existing checkpoint: 2 turns already sent.
    saveCheckpoint(tmpDir, {
      openclawSessionId: "s-inc",
      sessionKey: "k",
      agentId: "main",
      ovSessionId: "ov-existing",
      lastFlushedIndex: 2,
      finalized: false,
      updatedAt: new Date().toISOString(),
    });

    // Only the /messages and /commit calls should happen (no /health or session create).
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const u = String(url);
      const method = opts.method ?? "GET";
      if (u.includes("/messages") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ok",
              result: { session_id: "ov-existing", message_count: 3 },
            }),
        });
      }
      if (u.includes("/commit") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok", result: {} }),
        });
      }
      return Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({ status: "error", error: { message: `unexpected: ${method} ${u}` } }),
      });
    });

    const result = await flushSessionToOV({
      openclawSessionId: "s-inc",
      sessionKey: "k",
      agentId: "main",
      sessionFile,
      cfg,
      isFinalFlush: true,
    });

    expect(result.ok).toBe(true);
    expect(result.turnsFlushed).toBe(1); // only Turn 3 was new
    expect(result.ovSessionId).toBe("ov-existing");

    // Verify only 1 addMessage call was made.
    const messageCalls = fetchMock.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("/messages"),
    );
    expect(messageCalls).toHaveLength(1);
  });

  it("does not commit when commitOnFlush is false", async () => {
    const sessionFile = path.join(tmpDir, "session-nc.jsonl");
    writeTranscript(sessionFile, [{ role: "user", content: "Hi" }]);
    mockOvSuccess("ov-no-commit");

    const result = await flushSessionToOV({
      openclawSessionId: "s-nc",
      sessionKey: "k",
      agentId: "main",
      sessionFile,
      cfg: { ...cfg, commitOnFlush: false },
      isFinalFlush: true,
    });

    expect(result.ok).toBe(true);
    expect(result.finalized).toBe(false);

    const commitCalls = fetchMock.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes("/commit"),
    );
    expect(commitCalls).toHaveLength(0);
  });

  it("returns ok:false on network error", async () => {
    const sessionFile = path.join(tmpDir, "session-err.jsonl");
    writeTranscript(sessionFile, [{ role: "user", content: "Hi" }]);

    fetchMock.mockRejectedValue(new Error("connection refused"));

    const result = await flushSessionToOV({
      openclawSessionId: "s-err",
      sessionKey: "k",
      agentId: "main",
      sessionFile,
      cfg,
      isFinalFlush: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
  });

  it("returns ok:true with skipped:true when no turns and not final", async () => {
    const result = await flushSessionToOV({
      openclawSessionId: "s-empty",
      sessionKey: "k",
      agentId: "main",
      cfg,
      isFinalFlush: false,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
