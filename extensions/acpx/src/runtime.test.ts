import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import {
  cleanupMockRuntimeFixtures,
  createMockRuntimeFixture,
  NOOP_LOGGER,
  readMockRuntimeLogEntries,
} from "./runtime-internals/test-fixtures.js";
import { AcpxRuntime, decodeAcpxRuntimeHandleState } from "./runtime.js";

let sharedFixture: Awaited<ReturnType<typeof createMockRuntimeFixture>> | null = null;
let missingCommandRuntime: AcpxRuntime | null = null;

beforeAll(async () => {
  sharedFixture = await createMockRuntimeFixture();
  missingCommandRuntime = new AcpxRuntime(
    {
      command: "/definitely/missing/acpx",
      allowPluginLocalInstall: false,
      installCommand: "n/a",
      cwd: process.cwd(),
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
      strictWindowsCmdWrapper: true,
      queueOwnerTtlSeconds: 0.1,
    },
    { logger: NOOP_LOGGER },
  );
});

afterAll(async () => {
  sharedFixture = null;
  missingCommandRuntime = null;
  await cleanupMockRuntimeFixtures();
});

describe("AcpxRuntime", () => {
  it("passes the shared ACP adapter contract suite", async () => {
    const fixture = await createMockRuntimeFixture();
    await runAcpRuntimeAdapterContract({
      createRuntime: async () => fixture.runtime,
      agentId: "codex",
      successPrompt: "contract-pass",
      includeControlChecks: false,
      assertSuccessEvents: (events) => {
        expect(events.some((event) => event.type === "done")).toBe(true);
      },
    });

    const logs = await readMockRuntimeLogEntries(fixture.logPath);
    expect(logs.some((entry) => entry.kind === "ensure")).toBe(true);
    expect(logs.some((entry) => entry.kind === "cancel")).toBe(true);
    expect(logs.some((entry) => entry.kind === "close")).toBe(true);
  });

  it("ensures sessions and streams prompt events", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture({ queueOwnerTtlSeconds: 180 });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:123",
      agent: "codex",
      mode: "persistent",
    });
    expect(handle.backend).toBe("acpx");
    expect(handle.acpxRecordId).toBe("rec-agent:codex:acp:123");
    expect(handle.agentSessionId).toBe("inner-agent:codex:acp:123");
    expect(handle.backendSessionId).toBe("sid-agent:codex:acp:123");
    const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    expect(decoded?.acpxRecordId).toBe("rec-agent:codex:acp:123");
    expect(decoded?.agentSessionId).toBe("inner-agent:codex:acp:123");
    expect(decoded?.backendSessionId).toBe("sid-agent:codex:acp:123");

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "hello world",
      mode: "prompt",
      requestId: "req-test",
    })) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text_delta",
          text: "thinking",
          stream: "thought",
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          text: "run-tests (in_progress)",
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text_delta",
          text: "echo:hello world",
          stream: "output",
        }),
      ]),
    );
    expect(events).toContainEqual({
      type: "done",
      stopReason: "end_turn",
    });

    const logs = await readMockRuntimeLogEntries(logPath);
    const ensure = logs.find((entry) => entry.kind === "ensure");
    const prompt = logs.find((entry) => entry.kind === "prompt");
    expect(ensure).toBeDefined();
    expect(prompt).toBeDefined();
    expect(prompt?.openclawShell).toBe("acp");
    expect(Array.isArray(prompt?.args)).toBe(true);
    const promptArgs = (prompt?.args as string[]) ?? [];
    expect(promptArgs).toContain("--ttl");
    expect(promptArgs).toContain("180");
    expect(promptArgs).toContain("--approve-all");
  });

  it("preserves leading spaces across streamed text deltas", async () => {
    const runtime = sharedFixture?.runtime;
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error("shared runtime fixture missing");
    }
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:space",
      agent: "codex",
      mode: "persistent",
    });

    const textDeltas: string[] = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "split-spacing",
      mode: "prompt",
      requestId: "req-space",
    })) {
      if (event.type === "text_delta" && event.stream === "output") {
        textDeltas.push(event.text);
      }
    }

    expect(textDeltas).toEqual(["alpha", " beta", " gamma"]);
    expect(textDeltas.join("")).toBe("alpha beta gamma");

    // Keep the default queue-owner TTL assertion on a runTurn that already exists.
    const activeLogPath = process.env.MOCK_ACPX_LOG;
    expect(activeLogPath).toBeDefined();
    const logs = await readMockRuntimeLogEntries(String(activeLogPath));
    const prompt = logs.find(
      (entry) =>
        entry.kind === "prompt" && String(entry.sessionName ?? "") === "agent:codex:acp:space",
    );
    expect(prompt).toBeDefined();
    const promptArgs = (prompt?.args as string[]) ?? [];
    const ttlFlagIndex = promptArgs.indexOf("--ttl");
    expect(ttlFlagIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs[ttlFlagIndex + 1]).toBe("0.1");
  });

  it("emits done once when ACP stream repeats stop reason responses", async () => {
    const runtime = sharedFixture?.runtime;
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error("shared runtime fixture missing");
    }
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:double-done",
      agent: "codex",
      mode: "persistent",
    });

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "double-done",
      mode: "prompt",
      requestId: "req-double-done",
    })) {
      events.push(event);
    }

    const doneCount = events.filter((event) => event.type === "done").length;
    expect(doneCount).toBe(1);
  });

  it("maps acpx error events into ACP runtime error events", async () => {
    const runtime = sharedFixture?.runtime;
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error("shared runtime fixture missing");
    }
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:456",
      agent: "codex",
      mode: "persistent",
    });

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "trigger-error",
      mode: "prompt",
      requestId: "req-err",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "error",
      message: "mock failure",
      code: "-32000",
      retryable: undefined,
    });
  });

  it("maps acpx permission-denied exits to actionable guidance", async () => {
    const runtime = sharedFixture?.runtime;
    expect(runtime).toBeDefined();
    if (!runtime) {
      throw new Error("shared runtime fixture missing");
    }
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:permission-denied",
      agent: "codex",
      mode: "persistent",
    });

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "permission-denied",
      mode: "prompt",
      requestId: "req-perm",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Permission denied by ACP runtime (acpx)."),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("approve-reads, approve-all, deny-all"),
      }),
    );
  });

  it("supports cancel and close using encoded runtime handle state", async () => {
    const { runtime, logPath, config } = await createMockRuntimeFixture();
    const handle = await runtime.ensureSession({
      sessionKey: "agent:claude:acp:789",
      agent: "claude",
      mode: "persistent",
    });

    const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
    expect(decoded?.name).toBe("agent:claude:acp:789");

    const secondRuntime = new AcpxRuntime(config, { logger: NOOP_LOGGER });

    await secondRuntime.cancel({ handle, reason: "test" });
    await secondRuntime.close({ handle, reason: "test" });

    const logs = await readMockRuntimeLogEntries(logPath);
    const cancel = logs.find((entry) => entry.kind === "cancel");
    const close = logs.find((entry) => entry.kind === "close");
    expect(cancel?.sessionName).toBe("agent:claude:acp:789");
    expect(close?.sessionName).toBe("agent:claude:acp:789");
  });

  it("exposes control capabilities and runs set-mode/set/status commands", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture();
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:controls",
      agent: "codex",
      mode: "persistent",
    });

    const capabilities = runtime.getCapabilities();
    expect(capabilities.controls).toContain("session/set_mode");
    expect(capabilities.controls).toContain("session/set_config_option");
    expect(capabilities.controls).toContain("session/status");

    await runtime.setMode({
      handle,
      mode: "plan",
    });
    await runtime.setConfigOption({
      handle,
      key: "model",
      value: "openai-codex/gpt-5.3-codex",
    });
    const status = await runtime.getStatus({ handle });
    const ensuredSessionName = "agent:codex:acp:controls";

    expect(status.summary).toContain("status=alive");
    expect(status.acpxRecordId).toBe("rec-" + ensuredSessionName);
    expect(status.backendSessionId).toBe("sid-" + ensuredSessionName);
    expect(status.agentSessionId).toBe("inner-" + ensuredSessionName);
    expect(status.details?.acpxRecordId).toBe("rec-" + ensuredSessionName);
    expect(status.details?.status).toBe("alive");
    expect(status.details?.pid).toBe(4242);

    const logs = await readMockRuntimeLogEntries(logPath);
    expect(logs.find((entry) => entry.kind === "set-mode")?.mode).toBe("plan");
    expect(logs.find((entry) => entry.kind === "set")?.key).toBe("model");
    expect(logs.find((entry) => entry.kind === "status")).toBeDefined();
  });

  it("skips prompt execution when runTurn starts with an already-aborted signal", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture();
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:aborted",
      agent: "codex",
      mode: "persistent",
    });
    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      text: "should-not-run",
      mode: "prompt",
      requestId: "req-aborted",
      signal: controller.signal,
    })) {
      events.push(event);
    }

    const logs = await readMockRuntimeLogEntries(logPath);
    expect(events).toEqual([]);
    expect(logs.some((entry) => entry.kind === "prompt")).toBe(false);
  });

  it("does not mark backend unhealthy when a per-session cwd is missing", async () => {
    const { runtime } = await createMockRuntimeFixture();
    const missingCwd = path.join(os.tmpdir(), "openclaw-acpx-runtime-test-missing-cwd");

    await runtime.probeAvailability();
    expect(runtime.isHealthy()).toBe(true);

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:acp:missing-cwd",
        agent: "codex",
        mode: "persistent",
        cwd: missingCwd,
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: expect.stringContaining("working directory does not exist"),
    });
    expect(runtime.isHealthy()).toBe(true);
  });

  it("marks runtime unhealthy when command is missing", async () => {
    expect(missingCommandRuntime).toBeDefined();
    if (!missingCommandRuntime) {
      throw new Error("missing-command runtime fixture missing");
    }
    await missingCommandRuntime.probeAvailability();
    expect(missingCommandRuntime.isHealthy()).toBe(false);
  });

  it("logs ACPX spawn resolution once per command policy", async () => {
    const { config } = await createMockRuntimeFixture();
    const debugLogs: string[] = [];
    const runtime = new AcpxRuntime(
      {
        ...config,
        strictWindowsCmdWrapper: true,
      },
      {
        logger: {
          ...NOOP_LOGGER,
          debug: (message: string) => {
            debugLogs.push(message);
          },
        },
      },
    );

    await runtime.probeAvailability();

    const spawnLogs = debugLogs.filter((entry) => entry.startsWith("acpx spawn resolver:"));
    expect(spawnLogs.length).toBe(1);
    expect(spawnLogs[0]).toContain("mode=strict");
  });

  it("returns doctor report for missing command", async () => {
    expect(missingCommandRuntime).toBeDefined();
    if (!missingCommandRuntime) {
      throw new Error("missing-command runtime fixture missing");
    }
    const report = await missingCommandRuntime.doctor();
    expect(report.ok).toBe(false);
    expect(report.code).toBe("ACP_BACKEND_UNAVAILABLE");
    expect(report.installCommand).toContain("acpx");
  });

  it("falls back to 'sessions new' when 'sessions ensure' returns no session IDs", async () => {
    process.env.MOCK_ACPX_ENSURE_EMPTY = "1";
    try {
      const { runtime, logPath } = await createMockRuntimeFixture();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:claude:acp:fallback-test",
        agent: "claude",
        mode: "persistent",
      });
      expect(handle.backend).toBe("acpx");
      expect(handle.acpxRecordId).toBe("rec-agent:claude:acp:fallback-test");
      expect(handle.agentSessionId).toBe("inner-agent:claude:acp:fallback-test");

      const logs = await readMockRuntimeLogEntries(logPath);
      expect(logs.some((entry) => entry.kind === "ensure")).toBe(true);
      expect(logs.some((entry) => entry.kind === "new")).toBe(true);
    } finally {
      delete process.env.MOCK_ACPX_ENSURE_EMPTY;
    }
  });

  it("fails with ACP_SESSION_INIT_FAILED when both ensure and new omit session IDs", async () => {
    process.env.MOCK_ACPX_ENSURE_EMPTY = "1";
    process.env.MOCK_ACPX_NEW_EMPTY = "1";
    try {
      const { runtime, logPath } = await createMockRuntimeFixture();

      await expect(
        runtime.ensureSession({
          sessionKey: "agent:claude:acp:fallback-fail",
          agent: "claude",
          mode: "persistent",
        }),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining("neither 'sessions ensure' nor 'sessions new'"),
      });

      const logs = await readMockRuntimeLogEntries(logPath);
      expect(logs.some((entry) => entry.kind === "ensure")).toBe(true);
      expect(logs.some((entry) => entry.kind === "new")).toBe(true);
    } finally {
      delete process.env.MOCK_ACPX_ENSURE_EMPTY;
      delete process.env.MOCK_ACPX_NEW_EMPTY;
    }
  });
});
