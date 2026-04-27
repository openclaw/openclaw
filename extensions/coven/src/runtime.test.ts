import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
} from "openclaw/plugin-sdk/acp-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CovenClient, CovenEventRecord, CovenSessionRecord } from "./client.js";
import type { ResolvedCovenPluginConfig } from "./config.js";
import { CovenAcpRuntime } from "./runtime.js";

const config: ResolvedCovenPluginConfig = {
  covenHome: "/tmp/coven",
  socketPath: "/tmp/coven/coven.sock",
  fallbackBackend: "acpx",
  pollIntervalMs: 1,
  harnesses: {},
};

function session(overrides: Partial<CovenSessionRecord> = {}): CovenSessionRecord {
  return {
    id: "session-1",
    projectRoot: "/repo",
    harness: "codex",
    title: "Fix tests",
    status: "running",
    exitCode: null,
    createdAt: "2026-04-27T10:00:00Z",
    updatedAt: "2026-04-27T10:00:00Z",
    ...overrides,
  };
}

function event(overrides: Partial<CovenEventRecord>): CovenEventRecord {
  return {
    id: "event-1",
    sessionId: "session-1",
    kind: "output",
    payloadJson: JSON.stringify({ data: "hello\n" }),
    createdAt: "2026-04-27T10:00:00Z",
    ...overrides,
  };
}

function fakeClient(overrides: Partial<CovenClient> = {}): CovenClient {
  return {
    health: vi.fn(async () => ({ ok: true, daemon: null })),
    launchSession: vi.fn(async () => session()),
    getSession: vi.fn(async () => session({ status: "completed", exitCode: 0 })),
    listEvents: vi.fn(async () => [
      event({ id: "event-1", kind: "output", payloadJson: JSON.stringify({ data: "hello\n" }) }),
      event({
        id: "event-2",
        kind: "exit",
        payloadJson: JSON.stringify({ status: "completed", exitCode: 0 }),
      }),
    ]),
    sendInput: vi.fn(async () => undefined),
    killSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const events: AcpRuntimeEvent[] = [];
  for await (const item of iterable) {
    events.push(item);
  }
  return events;
}

function fallbackRuntime(): AcpRuntime {
  const handle: AcpRuntimeHandle = {
    sessionKey: "agent:codex:test",
    backend: "acpx",
    runtimeSessionName: "fallback-session",
    cwd: "/repo",
  };
  return {
    ensureSession: vi.fn(async () => handle),
    async *runTurn() {
      yield { type: "text_delta", text: "direct fallback\n", stream: "output" };
      yield { type: "done", stopReason: "complete" };
    },
    getStatus: vi.fn(async () => ({ summary: "fallback active" })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  unregisterAcpRuntimeBackend("acpx");
});

describe("CovenAcpRuntime", () => {
  it("falls back to the direct ACP backend when Coven is unavailable", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const runtime = new CovenAcpRuntime({
      config,
      client: fakeClient({ health: vi.fn(async () => Promise.reject(new Error("offline"))) }),
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: "/repo",
    });

    expect(handle.backend).toBe("acpx");
    expect(fallback.ensureSession).toHaveBeenCalledOnce();
  });

  it("launches a Coven session and streams output events to ACP", async () => {
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: "/repo",
    });

    const events = await collect(
      runtime.runTurn({
        handle,
        text: "Fix tests",
        mode: "prompt",
        requestId: "req-1",
      }),
    );

    expect(client.launchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/repo",
        cwd: "/repo",
        harness: "codex",
        prompt: "Fix tests",
      }),
      undefined,
    );
    expect(handle.backendSessionId).toBe("session-1");
    expect(events).toEqual([
      expect.objectContaining({ type: "status", text: "coven session session-1 started (codex)" }),
      expect.objectContaining({ type: "text_delta", text: "hello\n" }),
      expect.objectContaining({ type: "status", text: "coven session completed exitCode=0" }),
      expect.objectContaining({ type: "done", stopReason: "completed" }),
    ]);
  });

  it("preserves direct fallback when Coven launch fails after detection", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const runtime = new CovenAcpRuntime({
      config,
      client: fakeClient({
        launchSession: vi.fn(async () => Promise.reject(new Error("launch failed"))),
      }),
    });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: "/repo",
    });

    const events = await collect(
      runtime.runTurn({ handle, text: "Fix tests", mode: "prompt", requestId: "req-1" }),
    );

    expect(handle.backend).toBe("acpx");
    expect(events).toEqual([
      expect.objectContaining({ type: "text_delta", text: "direct fallback\n" }),
      expect.objectContaining({ type: "done", stopReason: "complete" }),
    ]);
  });
});
