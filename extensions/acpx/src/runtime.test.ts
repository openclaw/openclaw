import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runAcpRuntimeAdapterContract } from "openclaw/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAcpxPluginConfig } from "./config.js";
import { AcpxRuntime, decodeAcpxRuntimeHandleState } from "./runtime.js";
import {
  cleanupMockRuntimeFixtures,
  createMockRuntimeFixture,
  NOOP_LOGGER,
  readMockRuntimeLogEntries,
} from "./test-utils/runtime-fixtures.js";

let sharedFixture: Awaited<ReturnType<typeof createMockRuntimeFixture>> | null = null;
let missingCommandRuntime: AcpxRuntime | null = null;

beforeAll(async () => {
  sharedFixture = await createMockRuntimeFixture();
  missingCommandRuntime = new AcpxRuntime(
    {
      command: "/definitely/missing/acpx",
      allowPluginLocalInstall: false,
      stripProviderAuthEnvVars: false,
      installCommand: "n/a",
      cwd: process.cwd(),
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
      pluginToolsMcpBridge: false,
      strictWindowsCmdWrapper: true,
      queueOwnerTtlSeconds: 0.1,
      mcpServers: {},
    },
    { logger: NOOP_LOGGER },
  );
});

afterAll(async () => {
  sharedFixture = null;
  missingCommandRuntime = null;
  await cleanupMockRuntimeFixtures();
});

async function expectSessionEnsureFallback(params: {
  sessionKey: string;
  env?: Record<string, string>;
  expectNewAfterStatus: boolean;
  expectedRecordId?: string;
  expectedResumeSessionId?: string | null;
}) {
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(params.env ?? {})) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const { runtime, logPath } = await createMockRuntimeFixture();
    const handle = await runtime.ensureSession({
      sessionKey: params.sessionKey,
      agent: "codex",
      mode: "persistent",
    });

    expect(handle.backend).toBe("acpx");
    if (params.expectedRecordId) {
      expect(handle.acpxRecordId).toBe(params.expectedRecordId);
    }

    const logs = await readMockRuntimeLogEntries(logPath);
    const ensureIndex = logs.findIndex((entry) => entry.kind === "ensure");
    const statusIndex = logs.findIndex((entry) => entry.kind === "status");
    const newEntries = logs.filter((entry) => entry.kind === "new");
    const newEntry = newEntries[0] ?? null;
    const newIndex = newEntry ? logs.indexOf(newEntry) : -1;
    expect(ensureIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(ensureIndex);
    if (params.expectNewAfterStatus) {
      expect(newEntries).toHaveLength(1);
      expect(newIndex).toBeGreaterThan(statusIndex);
    } else {
      expect(newEntries).toHaveLength(0);
    }
    const newArgs = ((newEntry?.args as string[]) ?? []).slice();
    const resumeFlagIndex = newArgs.indexOf("--resume-session");
    if (params.expectedResumeSessionId === undefined) {
      // No assertion requested for resume behavior.
    } else if (params.expectedResumeSessionId === null) {
      expect(resumeFlagIndex).toBe(-1);
    } else {
      expect(resumeFlagIndex).toBeGreaterThanOrEqual(0);
      expect(newArgs[resumeFlagIndex + 1]).toBe(params.expectedResumeSessionId);
    }
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

  it("surfaces signal-only prompt exits as runtime errors", async () => {
    const previousSignal = process.env.MOCK_ACPX_PROMPT_SIGNAL;
    process.env.MOCK_ACPX_PROMPT_SIGNAL = "SIGTERM";

    try {
      const { runtime } = await createMockRuntimeFixture();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:acp:signal-exit",
        agent: "codex",
        mode: "persistent",
      });

      const events = [];
      for await (const event of runtime.runTurn({
        handle,
        text: "signal-only-exit",
        mode: "prompt",
        requestId: "req-signal",
      })) {
        events.push(event);
      }

      expect(events).toContainEqual({
        type: "error",
        message: "acpx exited with signal SIGTERM",
      });
      expect(events.some((event) => event.type === "done")).toBe(false);
    } finally {
      if (previousSignal === undefined) {
        delete process.env.MOCK_ACPX_PROMPT_SIGNAL;
      } else {
        process.env.MOCK_ACPX_PROMPT_SIGNAL = previousSignal;
      }
    }
  });

  it("uses sessions new with --resume-session when resumeSessionId is provided", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture();
    const resumeSessionId = "sid-resume-123";
    const sessionKey = "agent:codex:acp:resume";
    const handle = await runtime.ensureSession({
      sessionKey,
      agent: "codex",
      mode: "persistent",
      resumeSessionId,
    });

    expect(handle.backend).toBe("acpx");
    expect(handle.acpxRecordId).toBe("rec-" + sessionKey);

    const logs = await readMockRuntimeLogEntries(logPath);
    expect(logs.some((entry) => entry.kind === "ensure")).toBe(false);
    const resumeEntry = logs.find(
      (entry) => entry.kind === "new" && String(entry.sessionName ?? "") === sessionKey,
    );
    expect(resumeEntry).toBeDefined();
    const resumeArgs = (resumeEntry?.args as string[]) ?? [];
    const resumeFlagIndex = resumeArgs.indexOf("--resume-session");
    expect(resumeFlagIndex).toBeGreaterThanOrEqual(0);
    expect(resumeArgs[resumeFlagIndex + 1]).toBe(resumeSessionId);
  });

  it("repairs dead named sessions when status only reports queue owner unavailable", async () => {
    await expectSessionEnsureFallback({
      sessionKey: "agent:codex:acp:dead-session",
      env: {
        MOCK_ACPX_STATUS_STATUS: "dead",
        MOCK_ACPX_STATUS_SUMMARY: "queue owner unavailable",
      },
      expectNewAfterStatus: true,
      expectedResumeSessionId: "sid-agent:codex:acp:dead-session",
    });
  });

  it("replaces dead named sessions when status indicates an unrecoverable failure", async () => {
    await expectSessionEnsureFallback({
      sessionKey: "agent:codex:acp:dead-session-unrecoverable",
      env: {
        MOCK_ACPX_STATUS_STATUS: "dead",
        MOCK_ACPX_STATUS_SUMMARY: "agent process exited",
      },
      expectNewAfterStatus: true,
    });
  });

  it("reuses a live named session when sessions ensure exits before returning identifiers", async () => {
    await expectSessionEnsureFallback({
      sessionKey: "agent:codex:acp:ensure-fallback-alive",
      env: {
        MOCK_ACPX_ENSURE_EXIT_1: "1",
        MOCK_ACPX_STATUS_STATUS: "alive",
      },
      expectNewAfterStatus: false,
      expectedRecordId: "rec-agent:codex:acp:ensure-fallback-alive",
    });
  });

  it("repairs the named session after ensure failure when status only reports queue owner unavailable", async () => {
    await expectSessionEnsureFallback({
      sessionKey: "agent:codex:acp:ensure-fallback-dead",
      env: {
        MOCK_ACPX_ENSURE_EXIT_1: "1",
        MOCK_ACPX_STATUS_STATUS: "dead",
        MOCK_ACPX_STATUS_SUMMARY: "queue owner unavailable",
      },
      expectNewAfterStatus: true,
      expectedRecordId: "rec-agent:codex:acp:ensure-fallback-dead",
      expectedResumeSessionId: "sid-agent:codex:acp:ensure-fallback-dead",
    });
  });

  it("falls back to a fresh named session when queue owner recovery has no resumable id", async () => {
    await expectSessionEnsureFallback({
      sessionKey: "agent:codex:acp:dead-session-no-ids",
      env: {
        MOCK_ACPX_STATUS_STATUS: "dead",
        MOCK_ACPX_STATUS_SUMMARY: "queue owner unavailable",
        MOCK_ACPX_STATUS_NO_IDS: "1",
      },
      expectNewAfterStatus: true,
      expectedResumeSessionId: null,
    });
  });

  it("falls back to a fresh named session when queue owner resume repair uses a stale session id", async () => {
    const previousResumeFailure = process.env.MOCK_ACPX_NEW_FAIL_ON_RESUME;
    const previousStatus = process.env.MOCK_ACPX_STATUS_STATUS;
    const previousSummary = process.env.MOCK_ACPX_STATUS_SUMMARY;
    process.env.MOCK_ACPX_NEW_FAIL_ON_RESUME = "1";
    process.env.MOCK_ACPX_STATUS_STATUS = "dead";
    process.env.MOCK_ACPX_STATUS_SUMMARY = "queue owner unavailable";

    try {
      const { runtime, logPath } = await createMockRuntimeFixture();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:acp:dead-session-stale-resume",
        agent: "codex",
        mode: "persistent",
      });

      expect(handle.backend).toBe("acpx");

      const logs = await readMockRuntimeLogEntries(logPath);
      const newEntries = logs.filter((entry) => entry.kind === "new");
      expect(newEntries).toHaveLength(2);
      const firstArgs = ((newEntries[0]?.args as string[]) ?? []).slice();
      const secondArgs = ((newEntries[1]?.args as string[]) ?? []).slice();
      const firstResumeFlagIndex = firstArgs.indexOf("--resume-session");
      expect(firstResumeFlagIndex).toBeGreaterThanOrEqual(0);
      expect(firstArgs[firstResumeFlagIndex + 1]).toBe(
        "sid-agent:codex:acp:dead-session-stale-resume",
      );
      expect(secondArgs.indexOf("--resume-session")).toBe(-1);
    } finally {
      if (previousResumeFailure === undefined) {
        delete process.env.MOCK_ACPX_NEW_FAIL_ON_RESUME;
      } else {
        process.env.MOCK_ACPX_NEW_FAIL_ON_RESUME = previousResumeFailure;
      }
      if (previousStatus === undefined) {
        delete process.env.MOCK_ACPX_STATUS_STATUS;
      } else {
        process.env.MOCK_ACPX_STATUS_STATUS = previousStatus;
      }
      if (previousSummary === undefined) {
        delete process.env.MOCK_ACPX_STATUS_SUMMARY;
      } else {
        process.env.MOCK_ACPX_STATUS_SUMMARY = previousSummary;
      }
    }
  });

  it("creates a fresh named session after ensure failure when status indicates an unrecoverable failure", async () => {
    await expectSessionEnsureFallback({
      sessionKey: "agent:codex:acp:ensure-fallback-dead-unrecoverable",
      env: {
        MOCK_ACPX_ENSURE_EXIT_1: "1",
        MOCK_ACPX_STATUS_STATUS: "dead",
        MOCK_ACPX_STATUS_SUMMARY: "agent process exited",
      },
      expectNewAfterStatus: true,
    });
  });

  it("surfaces structured control-command errors from sessions ensure", async () => {
    const previousEnsureExit = process.env.MOCK_ACPX_ENSURE_EXIT_1;
    const previousStatusSignal = process.env.MOCK_ACPX_STATUS_SIGNAL;
    process.env.MOCK_ACPX_ENSURE_EXIT_1 = "1";
    process.env.MOCK_ACPX_STATUS_SIGNAL = "SIGTERM";

    try {
      const { runtime } = await createMockRuntimeFixture();
      await expect(
        runtime.ensureSession({
          sessionKey: "agent:codex:acp:ensure-structured-error",
          agent: "codex",
          mode: "persistent",
        }),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: "-32603: mock ensure failure",
      });
    } finally {
      if (previousEnsureExit === undefined) {
        delete process.env.MOCK_ACPX_ENSURE_EXIT_1;
      } else {
        process.env.MOCK_ACPX_ENSURE_EXIT_1 = previousEnsureExit;
      }
      if (previousStatusSignal === undefined) {
        delete process.env.MOCK_ACPX_STATUS_SIGNAL;
      } else {
        process.env.MOCK_ACPX_STATUS_SIGNAL = previousStatusSignal;
      }
    }
  });

  it("appends stderr details when control-command errors are generic", async () => {
    const previousEnsureExit = process.env.MOCK_ACPX_ENSURE_EXIT_1;
    const previousEnsureMessage = process.env.MOCK_ACPX_ENSURE_ERROR_MESSAGE;
    const previousEnsureStderr = process.env.MOCK_ACPX_ENSURE_STDERR;
    const previousStatusSignal = process.env.MOCK_ACPX_STATUS_SIGNAL;
    process.env.MOCK_ACPX_ENSURE_EXIT_1 = "1";
    process.env.MOCK_ACPX_ENSURE_ERROR_MESSAGE = "Internal error";
    process.env.MOCK_ACPX_ENSURE_STDERR = "usage limit exceeded";
    process.env.MOCK_ACPX_STATUS_SIGNAL = "SIGTERM";

    try {
      const { runtime } = await createMockRuntimeFixture();
      await expect(
        runtime.ensureSession({
          sessionKey: "agent:codex:acp:ensure-generic-error",
          agent: "codex",
          mode: "persistent",
        }),
      ).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: "-32603: Internal error | usage limit exceeded",
      });
    } finally {
      if (previousEnsureExit === undefined) {
        delete process.env.MOCK_ACPX_ENSURE_EXIT_1;
      } else {
        process.env.MOCK_ACPX_ENSURE_EXIT_1 = previousEnsureExit;
      }
      if (previousEnsureMessage === undefined) {
        delete process.env.MOCK_ACPX_ENSURE_ERROR_MESSAGE;
      } else {
        process.env.MOCK_ACPX_ENSURE_ERROR_MESSAGE = previousEnsureMessage;
      }
      if (previousEnsureStderr === undefined) {
        delete process.env.MOCK_ACPX_ENSURE_STDERR;
      } else {
        process.env.MOCK_ACPX_ENSURE_STDERR = previousEnsureStderr;
      }
      if (previousStatusSignal === undefined) {
        delete process.env.MOCK_ACPX_STATUS_SIGNAL;
      } else {
        process.env.MOCK_ACPX_STATUS_SIGNAL = previousStatusSignal;
      }
    }
  });

  it("serializes text plus image attachments into ACP prompt blocks", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture();

    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:with-image",
      agent: "codex",
      mode: "persistent",
    });

    for await (const _event of runtime.runTurn({
      handle,
      text: "describe this image",
      attachments: [{ mediaType: "image/png", data: "aW1hZ2UtYnl0ZXM=" }], // pragma: allowlist secret
      mode: "prompt",
      requestId: "req-image",
    })) {
      // Consume stream to completion so prompt logging is finalized.
    }

    const logs = await readMockRuntimeLogEntries(logPath);
    const prompt = logs.find(
      (entry) =>
        entry.kind === "prompt" && String(entry.sessionName ?? "") === "agent:codex:acp:with-image",
    );
    expect(prompt).toBeDefined();

    const stdinBlocks = JSON.parse(String(prompt?.stdinText ?? ""));
    expect(stdinBlocks).toEqual([
      { type: "text", text: "describe this image" },
      { type: "image", mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
    ]);
  });

  it("preserves provider auth env vars when runtime uses a custom acpx command", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-secret"); // pragma: allowlist secret
    vi.stubEnv("GITHUB_TOKEN", "gh-secret"); // pragma: allowlist secret

    try {
      const { runtime, logPath } = await createMockRuntimeFixture();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:acp:custom-env",
        agent: "codex",
        mode: "persistent",
      });

      for await (const _event of runtime.runTurn({
        handle,
        text: "custom-env",
        mode: "prompt",
        requestId: "req-custom-env",
      })) {
        // Drain events; assertions inspect the mock runtime log.
      }

      const logs = await readMockRuntimeLogEntries(logPath);
      const prompt = logs.find(
        (entry) =>
          entry.kind === "prompt" &&
          String(entry.sessionName ?? "") === "agent:codex:acp:custom-env",
      );
      expect(prompt?.openaiApiKey).toBe("openai-secret");
      expect(prompt?.githubToken).toBe("gh-secret");
    } finally {
      vi.unstubAllEnvs();
    }
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
      value: "openai-codex/gpt-5.4",
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

  it("surfaces signal-only status exits as control command failures", async () => {
    const previousSignal = process.env.MOCK_ACPX_STATUS_SIGNAL;
    process.env.MOCK_ACPX_STATUS_SIGNAL = "SIGTERM";

    try {
      const { runtime } = await createMockRuntimeFixture();
      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:acp:controls-signal",
        agent: "codex",
        mode: "persistent",
      });

      await expect(runtime.getStatus({ handle })).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: "acpx exited with signal SIGTERM",
      });
    } finally {
      if (previousSignal === undefined) {
        delete process.env.MOCK_ACPX_STATUS_SIGNAL;
      } else {
        process.env.MOCK_ACPX_STATUS_SIGNAL = previousSignal;
      }
    }
  });

  it("routes ACPX commands through an MCP proxy agent when MCP servers are configured", async () => {
    process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS = JSON.stringify({
      codex: {
        command: "npx custom-codex-acp",
      },
    });
    try {
      const { runtime, logPath } = await createMockRuntimeFixture({
        mcpServers: {
          canva: {
            command: "npx",
            args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
            env: {
              CANVA_TOKEN: "secret", // pragma: allowlist secret
            },
          },
        },
      });

      const handle = await runtime.ensureSession({
        sessionKey: "agent:codex:acp:mcp",
        agent: "codex",
        mode: "persistent",
      });
      await runtime.setMode({
        handle,
        mode: "plan",
      });

      const logs = await readMockRuntimeLogEntries(logPath);
      const ensureArgs = (logs.find((entry) => entry.kind === "ensure")?.args as string[]) ?? [];
      const setModeArgs = (logs.find((entry) => entry.kind === "set-mode")?.args as string[]) ?? [];

      for (const args of [ensureArgs, setModeArgs]) {
        const agentFlagIndex = args.indexOf("--agent");
        expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
        const rawAgentCommand = args[agentFlagIndex + 1];
        expect(rawAgentCommand).toContain("mcp-proxy.mjs");
        const payloadMatch = rawAgentCommand.match(/--payload\s+([A-Za-z0-9_-]+)/);
        expect(payloadMatch?.[1]).toBeDefined();
        const payload = JSON.parse(
          Buffer.from(String(payloadMatch?.[1]), "base64url").toString("utf8"),
        ) as {
          targetCommand: string;
        };
        expect(payload.targetCommand).toContain("custom-codex-acp");
      }
    } finally {
      delete process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS;
    }
  });

  it("routes ACPX commands through the built-in plugin-tools bridge only when explicitly enabled", async () => {
    process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS = JSON.stringify({
      codex: {
        command: "npx custom-codex-acp",
      },
    });
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acpx-plugin-tools-"));
    const pluginRoot = path.join(repoRoot, "extensions", "acpx");
    const distEntry = path.join(repoRoot, "dist", "mcp", "plugin-tools-serve.js");
    try {
      fs.mkdirSync(path.join(pluginRoot, "src"), { recursive: true });
      fs.mkdirSync(path.dirname(distEntry), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "package.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(pluginRoot, "src", "config.ts"), "// test\n", "utf8");
      fs.writeFileSync(distEntry, "// built entry\n", "utf8");

      const fixture = await createMockRuntimeFixture();
      const runtime = new AcpxRuntime(
        resolveAcpxPluginConfig({
          rawConfig: {
            command: fixture.config.command,
            pluginToolsMcpBridge: true,
          },
          workspaceDir: repoRoot,
          moduleUrl: pathToFileURL(path.join(pluginRoot, "src", "config.ts")).href,
        }),
        { logger: NOOP_LOGGER },
      );

      await runtime.ensureSession({
        sessionKey: "agent:codex:acp:plugin-tools-bridge",
        agent: "codex",
        mode: "persistent",
      });

      const logs = await readMockRuntimeLogEntries(fixture.logPath);
      const ensureArgs = (logs.find((entry) => entry.kind === "ensure")?.args as string[]) ?? [];
      const agentFlagIndex = ensureArgs.indexOf("--agent");
      expect(agentFlagIndex).toBeGreaterThanOrEqual(0);
      const rawAgentCommand = ensureArgs[agentFlagIndex + 1];
      expect(rawAgentCommand).toContain("mcp-proxy.mjs");
      const payloadMatch = rawAgentCommand.match(/--payload\s+([A-Za-z0-9_-]+)/);
      expect(payloadMatch?.[1]).toBeDefined();
      const payload = JSON.parse(
        Buffer.from(String(payloadMatch?.[1]), "base64url").toString("utf8"),
      ) as {
        targetCommand: string;
        mcpServers: Array<{ name: string; command: string; args: string[] }>;
      };
      expect(payload.targetCommand).toContain("custom-codex-acp");
      expect(payload.mcpServers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "openclaw-plugin-tools",
            command: process.execPath,
            args: [distEntry],
          }),
        ]),
      );
    } finally {
      delete process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS;
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not pass unknown agent ids through acpx --agent when MCP servers are configured", async () => {
    const { runtime, logPath } = await createMockRuntimeFixture({
      mcpServers: {
        canva: {
          command: "npx",
          args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
          env: {
            CANVA_TOKEN: "secret", // pragma: allowlist secret
          },
        },
      },
    });

    await runtime.ensureSession({
      sessionKey: "agent:sh:acp:mcp",
      agent: "sh -c whoami",
      mode: "persistent",
    });

    const logs = await readMockRuntimeLogEntries(logPath);
    const ensureArgs = (logs.find((entry) => entry.kind === "ensure")?.args as string[]) ?? [];
    expect(ensureArgs).not.toContain("--agent");
    expect(ensureArgs).toContain("sh -c whoami");
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

  it("marks runtime unhealthy when the help check exits on a signal", async () => {
    const previousSignal = process.env.MOCK_ACPX_HELP_SIGNAL;
    process.env.MOCK_ACPX_HELP_SIGNAL = "SIGTERM";

    try {
      const { runtime } = await createMockRuntimeFixture();
      await runtime.probeAvailability();
      expect(runtime.isHealthy()).toBe(false);
    } finally {
      if (previousSignal === undefined) {
        delete process.env.MOCK_ACPX_HELP_SIGNAL;
      } else {
        process.env.MOCK_ACPX_HELP_SIGNAL = previousSignal;
      }
    }
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
