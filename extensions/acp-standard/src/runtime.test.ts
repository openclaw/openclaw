import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpRuntimeEvent } from "../../../src/acp/runtime/types.js";
import type { ResolvedStandardAcpConfig } from "./config.js";
import { StandardAcpRuntime } from "./runtime.js";

const NOOP_LOGGER = {
  info: (_message: string) => {},
  warn: (_message: string) => {},
  error: (_message: string) => {},
  debug: (_message: string) => {},
};

/**
 * Minimal mock ACP agent that speaks JSON-RPC 2.0 over stdio.
 * Supports: initialize, session/new, session/prompt, session/cancel, session/set_mode.
 * Behaviour is controlled via environment variables:
 *   MOCK_FAIL_INIT=1    → return error on initialize
 *   MOCK_HANG_PROMPT=1  → never respond to session/prompt
 *   MOCK_BAD_JSON=1     → write malformed JSON on stdout before responding
 */
const MOCK_AGENT_SCRIPT = String.raw`#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (process.env.MOCK_BAD_JSON === "1" && method === "session/prompt") {
    process.stdout.write("NOT_JSON\n");
  }

  if (method === "initialize") {
    if (process.env.MOCK_FAIL_INIT === "1") {
      send({ jsonrpc: "2.0", id, error: { code: -1, message: "init failed" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { name: "mock" } } });
    return;
  }

  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "mock-session-1" } });
    return;
  }

  if (method === "session/prompt") {
    if (process.env.MOCK_HANG_PROMPT === "1") return; // never respond
    // Stream a text chunk then complete
    send({ jsonrpc: "2.0", method: "session/update", params: {
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }
    }});
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }

  if (method === "session/cancel") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "session/set_mode") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
});
`;

let tmpDir: string;
let scriptPath: string;

async function setup(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "acp-test-"));
  scriptPath = path.join(tmpDir, "mock-agent.cjs");
  await writeFile(scriptPath, MOCK_AGENT_SCRIPT);
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function makeConfig(env?: Record<string, string>): ResolvedStandardAcpConfig {
  return {
    command: process.execPath,
    args: [scriptPath],
    cwd: tmpDir,
    env: env ?? {},
  };
}

function makeRuntime(env?: Record<string, string>): StandardAcpRuntime {
  return new StandardAcpRuntime(makeConfig(env), NOOP_LOGGER);
}

async function collectEvents(
  runtime: StandardAcpRuntime,
  sessionKey: string,
  text: string,
  signal?: AbortSignal,
): Promise<AcpRuntimeEvent[]> {
  const handle = await runtime.ensureSession({ sessionKey, agent: "mock", mode: "persistent" });
  const events: AcpRuntimeEvent[] = [];
  for await (const event of runtime.runTurn({
    handle,
    text,
    mode: "prompt",
    requestId: "r1",
    signal,
  })) {
    events.push(event);
  }
  return events;
}

describe("StandardAcpRuntime", () => {
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // --- probeAvailability ---

  it("marks healthy when command exits 0", async () => {
    await setup();
    const runtime = makeRuntime();
    await runtime.probeAvailability();
    expect(runtime.isHealthy()).toBe(true);
  });

  it("marks unhealthy for missing command", async () => {
    await setup();
    const runtime = new StandardAcpRuntime(
      { command: "/no/such/binary", args: [], cwd: tmpDir, env: {} },
      NOOP_LOGGER,
    );
    await runtime.probeAvailability();
    expect(runtime.isHealthy()).toBe(false);
  });

  // --- ensureSession ---

  it("initializes and returns a session handle", async () => {
    await setup();
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "mock",
      mode: "persistent",
    });
    expect(handle.sessionKey).toBe("s1");
    expect(handle.runtimeSessionName).toBe("mock-session-1");
    runtime.closeAll();
  });

  it("reuses existing session on second call", async () => {
    await setup();
    const runtime = makeRuntime();
    const h1 = await runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" });
    const h2 = await runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" });
    expect(h1.runtimeSessionName).toBe(h2.runtimeSessionName);
    runtime.closeAll();
  });

  it("deduplicates concurrent ensureSession calls for the same key", async () => {
    await setup();
    const runtime = makeRuntime();
    const [h1, h2] = await Promise.all([
      runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" }),
      runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" }),
    ]);
    expect(h1.runtimeSessionName).toBe(h2.runtimeSessionName);
    runtime.closeAll();
  });

  it("reinitializes agent when cwd changes", async () => {
    await setup();
    const runtime = makeRuntime();
    const h1 = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "mock",
      mode: "persistent",
      cwd: tmpDir,
    });
    const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), "acp-test2-"));
    try {
      const h2 = await runtime.ensureSession({
        sessionKey: "s1",
        agent: "mock",
        mode: "persistent",
        cwd: tmpDir2,
      });
      expect(h2.cwd).toBe(tmpDir2);
      // Fresh init produces a new session handle (old process was killed)
      expect(h2.runtimeSessionName).toBe("mock-session-1");
    } finally {
      runtime.closeAll();
      await rm(tmpDir2, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("cleans up on initialization failure", async () => {
    await setup();
    const runtime = makeRuntime({ MOCK_FAIL_INIT: "1" });
    await expect(
      runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" }),
    ).rejects.toThrow();
    // Second attempt should also try fresh (not return stale agent).
    await expect(
      runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" }),
    ).rejects.toThrow();
  });

  // --- runTurn ---

  it("streams text and completes with done", async () => {
    await setup();
    const runtime = makeRuntime();
    const events = await collectEvents(runtime, "s1", "hi");
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    runtime.closeAll();
  });

  it("handles malformed JSON lines without crashing", async () => {
    await setup();
    const runtime = makeRuntime({ MOCK_BAD_JSON: "1" });
    const events = await collectEvents(runtime, "s1", "hi");
    // Should still complete despite the bad line
    expect(events.some((e) => e.type === "done")).toBe(true);
    runtime.closeAll();
  });

  it("yields cancelled done for pre-aborted signal", async () => {
    await setup();
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "mock",
      mode: "persistent",
    });
    const controller = new AbortController();
    controller.abort();
    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "r1",
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "done", stopReason: "cancelled" }]);
    runtime.closeAll();
  });

  it("yields cancelled done on mid-turn abort", async () => {
    await setup();
    const runtime = makeRuntime({ MOCK_HANG_PROMPT: "1" });
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "mock",
      mode: "persistent",
    });
    const controller = new AbortController();
    const events: AcpRuntimeEvent[] = [];
    // Abort after a short delay
    setTimeout(() => controller.abort(), 200);
    for await (const event of runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "r1",
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "cancelled" });
    runtime.closeAll();
  });

  // --- unexpected process exit ---

  it("yields error when agent process exits unexpectedly", async () => {
    await setup();
    // Script that exits immediately after session/new
    const crashScript = path.join(tmpDir, "crash-agent.cjs");
    await writeFile(
      crashScript,
      String.raw`#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let ready = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\n");
    return;
  }
  if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s" } }) + "\n");
    ready = true;
    return;
  }
  if (msg.method === "session/prompt" && ready) {
    process.exit(1); // crash
  }
});
`,
    );
    await chmod(crashScript, 0o755);

    const runtime = new StandardAcpRuntime(
      { command: process.execPath, args: [crashScript], cwd: tmpDir, env: {} },
      NOOP_LOGGER,
    );
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "mock",
      mode: "persistent",
    });
    const events: AcpRuntimeEvent[] = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "hi",
      mode: "prompt",
      requestId: "r1",
    })) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  // --- doctor ---

  it("returns ok doctor report when healthy", async () => {
    await setup();
    const runtime = makeRuntime();
    const report = await runtime.doctor!();
    expect(report.ok).toBe(true);
  });

  it("returns not-ok doctor report for missing command", async () => {
    await setup();
    const runtime = new StandardAcpRuntime(
      { command: "/no/such/binary", args: [], cwd: tmpDir, env: {} },
      NOOP_LOGGER,
    );
    const report = await runtime.doctor!();
    expect(report.ok).toBe(false);
    expect(report.code).toBe("ACP_BACKEND_UNAVAILABLE");
  });

  // --- setMode ---

  it("sends set_mode request without error", async () => {
    await setup();
    const runtime = makeRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "s1",
      agent: "mock",
      mode: "persistent",
    });
    await expect(runtime.setMode!({ handle, mode: "fast" })).resolves.toBeUndefined();
    runtime.closeAll();
  });

  // --- closeAll ---

  it("kills all agent processes on closeAll", async () => {
    await setup();
    const runtime = makeRuntime();
    await runtime.ensureSession({ sessionKey: "s1", agent: "mock", mode: "persistent" });
    await runtime.ensureSession({ sessionKey: "s2", agent: "mock", mode: "persistent" });
    runtime.closeAll();
    const status = await runtime.getStatus!({
      handle: { sessionKey: "s1", backend: "acp-standard", runtimeSessionName: "x", cwd: tmpDir },
    });
    expect(status.summary).toBe("no process");
  });
});
