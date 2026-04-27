import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
} from "openclaw/plugin-sdk/acp-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CovenClient, CovenEventRecord, CovenSessionRecord } from "./client.js";
import type { ResolvedCovenPluginConfig } from "./config.js";
import { __testing, CovenAcpRuntime } from "./runtime.js";

const baseConfig: ResolvedCovenPluginConfig = {
  covenHome: "",
  socketPath: "",
  workspaceDir: "",
  fallbackBackend: "acpx",
  pollIntervalMs: 1,
  harnesses: {},
};

let workspaceDir: string;
let config: ResolvedCovenPluginConfig;

beforeEach(async () => {
  workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-workspace-")),
  );
  const covenHome = path.join(workspaceDir, ".coven");
  await fs.mkdir(covenHome);
  config = {
    ...baseConfig,
    covenHome,
    socketPath: path.join(covenHome, "coven.sock"),
    workspaceDir,
  };
});

function session(overrides: Partial<CovenSessionRecord> = {}): CovenSessionRecord {
  return {
    id: "session-1",
    projectRoot: workspaceDir,
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
    cwd: workspaceDir,
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
  vi.useRealTimers();
  unregisterAcpRuntimeBackend("acpx");
  return fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("CovenAcpRuntime", () => {
  it("falls back to the direct ACP backend when Coven is unavailable", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const runtime = new CovenAcpRuntime({
      config,
      client: fakeClient({
        health: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    expect(handle.backend).toBe("acpx");
    expect(fallback.ensureSession).toHaveBeenCalledOnce();
  });

  it("falls back when Coven health checks do not settle before the deadline", async () => {
    vi.useFakeTimers();
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const client = fakeClient({
      health: vi.fn(
        async (signal?: AbortSignal) =>
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
              once: true,
            });
          }),
      ),
    });
    const runtime = new CovenAcpRuntime({ config, client });

    const pending = runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const handle = await pending;

    expect(handle.backend).toBe("acpx");
  });

  it("launches a Coven session and streams output events to ACP", async () => {
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
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
        projectRoot: workspaceDir,
        cwd: workspaceDir,
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

  it("sanitizes daemon-controlled session fields in start status", async () => {
    const client = fakeClient({
      launchSession: vi.fn(async () =>
        session({
          id: "\u001b]0;spoof\u0007session-1\r",
          harness: "\u001b[31mcodex\u001b[0m",
        }),
      ),
    });
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    const events = await collect(
      runtime.runTurn({
        handle,
        text: "Fix tests",
        mode: "prompt",
        requestId: "req-1",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "status", text: "coven session session-1 started (codex)" }),
    );
  });

  it("falls back without launching Coven when prompts exceed the Coven request limit", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    const events = await collect(
      runtime.runTurn({
        handle,
        text: "x".repeat(500_001),
        mode: "prompt",
        requestId: "req-1",
      }),
    );

    expect(client.launchSession).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ type: "text_delta", text: "direct fallback\n" }),
      expect.objectContaining({ type: "done", stopReason: "complete" }),
    ]);
  });

  it("ignores cwd embedded in runtimeSessionName when launching Coven sessions", async () => {
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });
    handle.runtimeSessionName = __testing.encodeRuntimeSessionName({
      agent: "codex",
      mode: "prompt",
      cwd: "/tmp/attacker",
    });

    await collect(
      runtime.runTurn({
        handle,
        text: "Fix tests",
        mode: "prompt",
        requestId: "req-1",
      }),
    );

    expect(client.launchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: workspaceDir,
        cwd: workspaceDir,
      }),
      undefined,
    );
  });

  it("rejects Coven handles whose cwd is outside the configured workspace", async () => {
    const runtime = new CovenAcpRuntime({ config, client: fakeClient() });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });
    handle.cwd = "/tmp/attacker";

    await expect(
      collect(
        runtime.runTurn({
          handle,
          text: "Fix tests",
          mode: "prompt",
          requestId: "req-1",
        }),
      ),
    ).rejects.toThrow(/outside workspace/);
  });

  it("rejects Coven cwd symlinks that resolve outside the workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-workspace-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-outside-"));
    const symlinkPath = path.join(workspaceDir, "outside");
    await fs.symlink(outsideDir, symlinkPath);
    try {
      const runtime = new CovenAcpRuntime({
        config: { ...config, workspaceDir },
        client: fakeClient(),
      });
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:test",
        agent: "codex",
        mode: "oneshot",
        cwd: symlinkPath,
      });

      await expect(
        collect(
          runtime.runTurn({
            handle,
            text: "Fix tests",
            mode: "prompt",
            requestId: "req-1",
          }),
        ),
      ).rejects.toThrow(/outside workspace/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("requests incremental events after the last processed Coven event", async () => {
    const client = fakeClient({
      listEvents: vi
        .fn()
        .mockResolvedValueOnce([
          event({
            id: "event-1",
            kind: "output",
            payloadJson: JSON.stringify({ data: "hello\n" }),
          }),
        ])
        .mockResolvedValueOnce([
          event({
            id: "event-2",
            kind: "exit",
            payloadJson: JSON.stringify({ status: "completed", exitCode: 0 }),
          }),
        ]),
      getSession: vi.fn(async () => session({ status: "running" })),
    });
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    await collect(
      runtime.runTurn({ handle, text: "Fix tests", mode: "prompt", requestId: "req-1" }),
    );

    expect(client.listEvents).toHaveBeenNthCalledWith(
      2,
      "session-1",
      {
        afterEventId: "event-1",
      },
      undefined,
    );
  });

  it("converts Coven polling failures into controlled terminal events", async () => {
    const client = fakeClient({
      listEvents: vi.fn(async () => {
        throw new Error("bad json");
      }),
      killSession: vi.fn(async () => undefined),
    });
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    const events = await collect(
      runtime.runTurn({ handle, text: "Fix tests", mode: "prompt", requestId: "req-1" }),
    );

    expect(client.killSession).toHaveBeenCalledWith("session-1", undefined);
    expect(events).toEqual([
      expect.objectContaining({ type: "status", text: "coven session session-1 started (codex)" }),
      expect.objectContaining({ type: "status", text: "coven session polling failed" }),
      expect.objectContaining({ type: "done", stopReason: "error" }),
    ]);
  });

  it("strips terminal escape and control characters from Coven output", () => {
    expect(
      __testing.sanitizeTerminalText(
        "\u001b]0;spoof\u0007hi\u001b[31m!\u001b[0m\u001b7\u001bc\u202e\r\n",
      ),
    ).toBe("hi!\n");
  });

  it("sanitizes prompt-derived session titles", () => {
    expect(__testing.titleFromPrompt("\u001b]0;spoof\u0007Fix\u001b[31m tests\r\nnow")).toBe(
      "Fix tests now",
    );
  });

  it("normalizes untrusted Coven exit status into bounded stop reasons", () => {
    expect(__testing.normalizeStopReason("completed")).toBe("completed");
    expect(__testing.normalizeStopReason("killed")).toBe("cancelled");
    expect(__testing.normalizeStopReason("refusal")).toBe("completed");

    expect(
      __testing.eventToRuntimeEvents(
        event({
          kind: "exit",
          payloadJson: JSON.stringify({ status: "refusal", exitCode: 0 }),
        }),
      ),
    ).toContainEqual(expect.objectContaining({ type: "done", stopReason: "completed" }));
  });

  it("rejects oversized Coven runtime session metadata", () => {
    expect(__testing.decodeRuntimeSessionName(`coven:${"a".repeat(2_049)}`)).toBeNull();
  });

  it("rejects missing Coven cwd paths before launching", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-coven-workspace-"));
    try {
      const runtime = new CovenAcpRuntime({
        config: { ...config, workspaceDir },
        client: fakeClient(),
      });
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:test",
        agent: "codex",
        mode: "oneshot",
        cwd: path.join(workspaceDir, "missing"),
      });

      await expect(
        collect(
          runtime.runTurn({
            handle,
            text: "Fix tests",
            mode: "prompt",
            requestId: "req-1",
          }),
        ),
      ).rejects.toThrow(/outside workspace/);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves direct fallback when Coven launch fails after detection", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const runtime = new CovenAcpRuntime({
      config,
      client: fakeClient({
        launchSession: vi.fn(async () => {
          throw new Error("launch failed");
        }),
      }),
    });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
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
