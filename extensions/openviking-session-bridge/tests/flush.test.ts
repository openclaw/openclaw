import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OVSessionBridgeConfig } from "../src/config.js";
import { enqueueFlush, flushSessionToOV, flushWithTimeout } from "../src/flush.js";
import { loadCheckpoint, saveCheckpoint } from "../src/state.js";

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

  // ── per-turn checkpoint advancement ───────────────────────────────────────

  it("advances checkpoint after each successfully sent turn (partial-progress semantics)", async () => {
    const sessionFile = path.join(tmpDir, "session-partial.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "Turn A" },
      { role: "assistant", content: "Turn B" },
      { role: "user", content: "Turn C" },
    ]);

    let callCount = 0;
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const u = String(url);
      const method = opts.method ?? "GET";
      if (u.includes("/health")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) });
      }
      if (u.endsWith("/api/v1/sessions") && method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok", result: { session_id: "ov-partial" } }),
        });
      }
      if (u.includes("/messages") && method === "POST") {
        callCount++;
        // Fail on the 3rd message send to simulate a mid-stream error.
        if (callCount === 3) {
          return Promise.reject(new Error("network blip on turn 3"));
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ok",
              result: { session_id: "ov-partial", message_count: callCount },
            }),
        });
      }
      return Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({ status: "error", error: { message: `unexpected: ${method} ${u}` } }),
      });
    });

    const result = await flushSessionToOV({
      openclawSessionId: "s-partial",
      sessionKey: "k",
      agentId: "main",
      sessionFile,
      cfg,
      isFinalFlush: true,
    });

    expect(result.ok).toBe(false);
    // 2 turns were sent successfully before the failure.
    expect(result.turnsFlushed).toBe(2);

    // Checkpoint must reflect the 2 successfully sent turns so a retry
    // does not re-send them (duplicate-message prevention).
    const cp = loadCheckpoint(tmpDir, "s-partial");
    expect(cp?.lastFlushedIndex).toBe(2);
    expect(cp?.ovSessionId).toBe("ov-partial");
    expect(cp?.finalized).toBe(false);
  });

  it("retry after partial failure sends only the remaining turn", async () => {
    const sessionFile = path.join(tmpDir, "session-retry.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Turn 2" },
      { role: "user", content: "Turn 3" },
    ]);

    // Seed checkpoint: 2 turns already sent, OV session exists.
    saveCheckpoint(tmpDir, {
      openclawSessionId: "s-retry",
      sessionKey: "k",
      agentId: "main",
      ovSessionId: "ov-retry-existing",
      lastFlushedIndex: 2,
      finalized: false,
      updatedAt: new Date().toISOString(),
    });

    let messageCalls = 0;
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const u = String(url);
      const method = opts.method ?? "GET";
      if (u.includes("/messages") && method === "POST") {
        messageCalls++;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ok",
              result: { session_id: "ov-retry-existing", message_count: messageCalls },
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
      openclawSessionId: "s-retry",
      sessionKey: "k",
      agentId: "main",
      sessionFile,
      cfg,
      isFinalFlush: true,
    });

    expect(result.ok).toBe(true);
    // Only 1 new turn (Turn 3) should be sent — not all 3.
    expect(result.turnsFlushed).toBe(1);
    expect(messageCalls).toBe(1);
  });
});

// ── flushWithTimeout / enqueueFlush serialization ────────────────────────────

describe("flushWithTimeout + enqueueFlush serialization", () => {
  let tmpDir: string;
  let cfg: OVSessionBridgeConfig;
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

  it("concurrent enqueueFlush calls for the same session are coalesced (not doubled)", async () => {
    const sessionFile = path.join(tmpDir, "session-concurrent.jsonl");
    writeTranscript(sessionFile, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    let sessionCreateCount = 0;
    let messageCount = 0;
    fetchMock.mockImplementation((url: string, opts: RequestInit) => {
      const u = String(url);
      const method = opts.method ?? "GET";
      if (u.includes("/health")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "ok" }) });
      }
      if (u.endsWith("/api/v1/sessions") && method === "POST") {
        sessionCreateCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok", result: { session_id: "ov-coalesce" } }),
        });
      }
      if (u.includes("/messages") && method === "POST") {
        messageCount++;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ok",
              result: { session_id: "ov-coalesce", message_count: messageCount },
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

    const params = {
      openclawSessionId: "s-concurrent",
      sessionKey: "k",
      agentId: "main",
      sessionFile,
      cfg,
      isFinalFlush: true,
    };

    // Fire two concurrent flush requests for the same session.
    const [r1, r2] = await Promise.all([enqueueFlush(params), enqueueFlush(params)]);

    // Both callers should get a successful result.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Only ONE OV session should have been created and only 2 messages sent
    // (not 4 from doubled work).
    expect(sessionCreateCount).toBe(1);
    expect(messageCount).toBe(2);
  });

  it("flushWithTimeout resolves with timeout error if flush is slow", async () => {
    const sessionFile = path.join(tmpDir, "session-slow.jsonl");
    writeTranscript(sessionFile, [{ role: "user", content: "Slow" }]);

    // Simulate a very slow network response.
    fetchMock.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const result = await flushWithTimeout(
      {
        openclawSessionId: "s-slow",
        sessionKey: "k",
        agentId: "main",
        sessionFile,
        cfg,
        isFinalFlush: true,
      },
      50, // 50ms timeout
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

// ── config schema ─────────────────────────────────────────────────────────────

describe("buildOVPluginConfigSchema", () => {
  it("accepts valid config", async () => {
    const { buildOVPluginConfigSchema } = await import("../src/config.js");
    const schema = buildOVPluginConfigSchema();
    const result = schema.safeParse?.({
      enabled: true,
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "secret",
      agentId: "main",
      timeoutMs: 10000,
      flushTimeoutMs: 30000,
      stateDir: "/tmp/test",
      commitOnFlush: true,
    });
    expect(result?.success).toBe(true);
  });

  it("accepts empty/undefined config (all defaults)", async () => {
    const { buildOVPluginConfigSchema } = await import("../src/config.js");
    const schema = buildOVPluginConfigSchema();
    expect(schema.safeParse?.(undefined)?.success).toBe(true);
    expect(schema.safeParse?.({})?.success).toBe(true);
  });

  it("rejects config with wrong field types", async () => {
    const { buildOVPluginConfigSchema } = await import("../src/config.js");
    const schema = buildOVPluginConfigSchema();
    const result = schema.safeParse?.({ enabled: "yes", timeoutMs: "fast" });
    expect(result?.success).toBe(false);
    if (result && !result.success && result.error?.issues) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("has jsonSchema with all config properties", async () => {
    const { buildOVPluginConfigSchema } = await import("../src/config.js");
    const schema = buildOVPluginConfigSchema();
    const props = (schema.jsonSchema?.properties ?? {}) as Record<string, unknown>;
    for (const key of [
      "enabled",
      "baseUrl",
      "apiKey",
      "agentId",
      "timeoutMs",
      "flushTimeoutMs",
      "stateDir",
      "commitOnFlush",
    ]) {
      expect(props).toHaveProperty(key);
    }
  });
});

// ── resolveEnvVars leniency ───────────────────────────────────────────────────

describe("parseOVSessionBridgeConfig env var resolution", () => {
  it("does not throw when a referenced env var is not set (lenient by default)", async () => {
    const { parseOVSessionBridgeConfig } = await import("../src/config.js");
    // OPENVIKING_MISSING_VAR is deliberately not set in test env.
    expect(() =>
      parseOVSessionBridgeConfig({
        enabled: false,
        baseUrl: "${OPENVIKING_MISSING_VAR}",
        apiKey: "${ANOTHER_MISSING_VAR}",
      }),
    ).not.toThrow();
  });

  it("leaves ${VAR} placeholder intact when env var is unset (lenient)", async () => {
    const { parseOVSessionBridgeConfig } = await import("../src/config.js");
    const cfg = parseOVSessionBridgeConfig({
      enabled: false,
      baseUrl: "${OPENVIKING_DEFINITELY_NOT_SET_XYZ}",
    });
    // The placeholder should be left as-is so it's visibly wrong at first use.
    expect(cfg.baseUrl).toBe("${OPENVIKING_DEFINITELY_NOT_SET_XYZ}");
  });
});

// ── listPendingCheckpoints ────────────────────────────────────────────────────

describe("listPendingCheckpoints", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ov-pending-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for empty dir", async () => {
    const { listPendingCheckpoints } = await import("../src/state.js");
    expect(listPendingCheckpoints(tmpDir)).toEqual([]);
  });

  it("returns non-finalized checkpoints only", async () => {
    const { listPendingCheckpoints } = await import("../src/state.js");
    const base = {
      sessionKey: "k",
      agentId: "main",
      ovSessionId: null,
      lastFlushedIndex: 2,
      updatedAt: new Date().toISOString(),
    };
    saveCheckpoint(tmpDir, { ...base, openclawSessionId: "s-pending", finalized: false });
    saveCheckpoint(tmpDir, { ...base, openclawSessionId: "s-done", finalized: true });

    const pending = listPendingCheckpoints(tmpDir);
    expect(pending.map((p) => p.openclawSessionId)).toContain("s-pending");
    expect(pending.map((p) => p.openclawSessionId)).not.toContain("s-done");
  });

  it("skips tmp files from in-progress writes", async () => {
    const { listPendingCheckpoints } = await import("../src/state.js");
    // Write a .tmp. file that should be ignored.
    fs.writeFileSync(
      path.join(tmpDir, "s-tmp.json.tmp.12345"),
      JSON.stringify({ openclawSessionId: "s-tmp", finalized: false }),
    );
    expect(listPendingCheckpoints(tmpDir)).toHaveLength(0);
  });
});
