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
  allowFallback: false,
  fallbackBackend: "acpx",
  pollIntervalMs: 25,
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
  it("fails closed by default when Coven is unavailable", async () => {
    const runtime = new CovenAcpRuntime({
      config,
      client: fakeClient({
        health: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    });

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:test",
        agent: "codex",
        mode: "oneshot",
        cwd: workspaceDir,
      }),
    ).rejects.toThrow(/fallback is disabled/);
  });

  it("falls back to the direct ACP backend when Coven is unavailable and fallback is enabled", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const runtime = new CovenAcpRuntime({
      config: { ...config, allowFallback: true },
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
    const runtime = new CovenAcpRuntime({ config: { ...config, allowFallback: true }, client });

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

  it("sanitizes daemon-controlled harness fields in start status", async () => {
    const client = fakeClient({
      launchSession: vi.fn(async () =>
        session({
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

  it("rejects unsafe daemon-controlled session ids before exposing handle fields", async () => {
    const client = fakeClient({
      launchSession: vi.fn(async () =>
        session({
          id: "\u001b]0;spoof\u0007session-1\r",
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

    await expect(
      collect(
        runtime.runTurn({
          handle,
          text: "Fix tests",
          mode: "prompt",
          requestId: "req-1",
        }),
      ),
    ).rejects.toThrow(/session id is invalid/);
    expect(handle.backendSessionId).toBeUndefined();
    expect(handle.agentSessionId).toBeUndefined();
  });

  it("fails closed without launching Coven when prompts exceed the Coven request limit", async () => {
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    await expect(
      collect(
        runtime.runTurn({
          handle,
          text: "x".repeat(500_001),
          mode: "prompt",
          requestId: "req-1",
        }),
      ),
    ).rejects.toThrow(/fallback is disabled/);

    expect(client.launchSession).not.toHaveBeenCalled();
  });

  it("falls back on oversized prompts when fallback is explicitly enabled", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config: { ...config, allowFallback: true }, client });
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

  it("clamps malformed runtime poll intervals before sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const client = fakeClient({
      listEvents: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          event({
            id: "event-1",
            kind: "exit",
            payloadJson: JSON.stringify({ status: "completed", exitCode: 0 }),
          }),
        ]),
      getSession: vi.fn(async () => session({ status: "running" })),
    });
    const runtime = new CovenAcpRuntime({
      config: { ...config, pollIntervalMs: 0 },
      client,
      sleep,
    });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });

    await collect(
      runtime.runTurn({ handle, text: "Fix tests", mode: "prompt", requestId: "req-1" }),
    );

    expect(sleep).toHaveBeenCalledWith(25, undefined);
  });

  it("fails the turn when the daemon returns too many events in one poll", async () => {
    const client = fakeClient({
      listEvents: vi.fn(async () =>
        Array.from({ length: 600 }, (_, index) =>
          event({
            id: `event-${index}`,
            kind: "output",
            payloadJson: JSON.stringify({ data: `line-${index}\n` }),
          }),
        ),
      ),
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

  it("drops oversized daemon event payloads before parsing", () => {
    expect(
      __testing.eventToRuntimeEvents(
        event({
          kind: "output",
          payloadJson: JSON.stringify({ data: "x".repeat(64_001) }),
        }),
      ),
    ).toEqual([]);
  });

  it("rejects oversized Coven runtime session metadata", () => {
    expect(__testing.decodeRuntimeSessionName(`coven:${"a".repeat(2_049)}`)).toBeNull();
  });

  it("bounds encoded Coven runtime session metadata before persistence", () => {
    const encoded = __testing.encodeRuntimeSessionName({
      agent: "A".repeat(5_000),
      mode: "prompt".repeat(1_000),
      sessionMode: "persistent".repeat(1_000),
      cwd: "/workspace/".repeat(1_000),
    });

    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual("coven:".length + 2_048);
    expect(__testing.decodeRuntimeSessionName(encoded)).toEqual({
      agent: "a".repeat(128),
      mode: "promptpromptpromptpromptpromptpr",
      sessionMode: "persistentpersistentpersistentpe",
    });
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

  it("rejects Coven cwd paths that are not directories", async () => {
    const filePath = path.join(workspaceDir, "not-a-directory");
    await fs.writeFile(filePath, "not a directory");
    const runtime = new CovenAcpRuntime({ config, client: fakeClient() });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: filePath,
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
    ).rejects.toThrow(/cwd must be a directory/);
  });

  it("does not trust persisted backendSessionId without an active tracked Coven session", async () => {
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle: AcpRuntimeHandle = {
      sessionKey: "agent:codex:test",
      backend: "coven",
      runtimeSessionName: __testing.encodeRuntimeSessionName({
        agent: "codex",
        mode: "prompt",
      }),
      cwd: workspaceDir,
      backendSessionId: "attacker-session",
    };

    await expect(runtime.getStatus({ handle })).resolves.toEqual({
      summary: "coven runtime ready",
    });
    await expect(runtime.cancel({ handle })).resolves.toBeUndefined();
    await expect(runtime.close({ handle, reason: "user" })).resolves.toBeUndefined();
    expect(client.getSession).not.toHaveBeenCalledWith("attacker-session", undefined);
    expect(client.killSession).not.toHaveBeenCalledWith("attacker-session", undefined);
  });

  it("rejects backendSessionId values that conflict with the active tracked Coven session", async () => {
    const client = fakeClient();
    const runtime = new CovenAcpRuntime({ config, client });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:test",
      agent: "codex",
      mode: "oneshot",
      cwd: workspaceDir,
    });
    const turn = runtime.runTurn({ handle, text: "Fix tests", mode: "prompt", requestId: "req-1" });
    const iterator = turn[Symbol.asyncIterator]();
    await iterator.next();
    handle.backendSessionId = "attacker-session";

    await expect(runtime.getStatus({ handle })).rejects.toThrow(/does not match/);
    await expect(runtime.cancel({ handle })).rejects.toThrow(/does not match/);
    await expect(runtime.close({ handle, reason: "user" })).rejects.toThrow(/does not match/);
    expect(client.getSession).not.toHaveBeenCalledWith("attacker-session", undefined);
    expect(client.killSession).not.toHaveBeenCalledWith("attacker-session", undefined);
    await iterator.return?.();
  });

  it("preserves direct fallback when Coven launch fails after detection", async () => {
    const fallback = fallbackRuntime();
    registerAcpRuntimeBackend({ id: "acpx", runtime: fallback });
    const runtime = new CovenAcpRuntime({
      config: { ...config, allowFallback: true },
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

  it("fails closed when Coven launch fails after detection and fallback is disabled", async () => {
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

    await expect(
      collect(runtime.runTurn({ handle, text: "Fix tests", mode: "prompt", requestId: "req-1" })),
    ).rejects.toThrow(/fallback is disabled/);
  });
});
