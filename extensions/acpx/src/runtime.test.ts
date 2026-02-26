import fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAcpRuntimeAdapterContract } from "../../../src/acp/runtime/adapter-contract.testkit.js";
import { ACPX_PINNED_VERSION, type ResolvedAcpxPluginConfig } from "./config.js";
import { AcpxRuntime, decodeAcpxRuntimeHandleState } from "./runtime.js";

const NOOP_LOGGER = {
  info: (_message: string) => {},
  warn: (_message: string) => {},
  error: (_message: string) => {},
  debug: (_message: string) => {},
};

const MOCK_CLI_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.MOCK_ACPX_LOG;
const writeLog = (entry) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};

if (args.includes("--version")) {
  process.stdout.write("mock-acpx ${ACPX_PINNED_VERSION}\\n");
  process.exit(0);
}

if (args.includes("--help")) {
  process.stdout.write("mock-acpx help\\n");
  process.exit(0);
}

const commandIndex = args.findIndex(
  (arg) =>
    arg === "prompt" ||
    arg === "cancel" ||
    arg === "sessions" ||
    arg === "set-mode" ||
    arg === "set" ||
    arg === "status",
);
const command = commandIndex >= 0 ? args[commandIndex] : "";
const agent = commandIndex > 0 ? args[commandIndex - 1] : "unknown";

const readFlag = (flag) => {
  const idx = args.indexOf(flag);
  if (idx < 0) return "";
  return String(args[idx + 1] || "");
};

const sessionFromOption = readFlag("--session");
const ensureName = readFlag("--name");
const closeName = command === "sessions" && args[commandIndex + 1] === "close" ? String(args[commandIndex + 2] || "") : "";
const setModeValue = command === "set-mode" ? String(args[commandIndex + 1] || "") : "";
const setKey = command === "set" ? String(args[commandIndex + 1] || "") : "";
const setValue = command === "set" ? String(args[commandIndex + 2] || "") : "";

if (command === "sessions" && args[commandIndex + 1] === "ensure") {
  writeLog({ kind: "ensure", agent, args, sessionName: ensureName });
  process.stdout.write(JSON.stringify({
    type: "session_ensured",
    acpxRecordId: "rec-" + ensureName,
    acpxSessionId: "sid-" + ensureName,
    agentSessionId: "inner-" + ensureName,
    name: ensureName,
    created: true,
  }) + "\n");
  process.exit(0);
}

if (command === "cancel") {
  writeLog({ kind: "cancel", agent, args, sessionName: sessionFromOption });
  process.stdout.write(JSON.stringify({
    acpxSessionId: "sid-" + sessionFromOption,
    cancelled: true,
  }) + "\n");
  process.exit(0);
}

if (command === "set-mode") {
  writeLog({ kind: "set-mode", agent, args, sessionName: sessionFromOption, mode: setModeValue });
  process.stdout.write(JSON.stringify({
    type: "mode_set",
    acpxSessionId: "sid-" + sessionFromOption,
    mode: setModeValue,
  }) + "\n");
  process.exit(0);
}

if (command === "set") {
  writeLog({
    kind: "set",
    agent,
    args,
    sessionName: sessionFromOption,
    key: setKey,
    value: setValue,
  });
  process.stdout.write(JSON.stringify({
    type: "config_set",
    acpxSessionId: "sid-" + sessionFromOption,
    key: setKey,
    value: setValue,
  }) + "\n");
  process.exit(0);
}

if (command === "status") {
  writeLog({ kind: "status", agent, args, sessionName: sessionFromOption });
  process.stdout.write(JSON.stringify({
    acpxRecordId: sessionFromOption ? "rec-" + sessionFromOption : null,
    acpxSessionId: sessionFromOption ? "sid-" + sessionFromOption : null,
    agentSessionId: sessionFromOption ? "inner-" + sessionFromOption : null,
    status: sessionFromOption ? "alive" : "no-session",
    pid: 4242,
    uptime: 120,
  }) + "\n");
  process.exit(0);
}

if (command === "sessions" && args[commandIndex + 1] === "close") {
  writeLog({ kind: "close", agent, args, sessionName: closeName });
  process.stdout.write(JSON.stringify({
    type: "session_closed",
    acpxRecordId: "rec-" + closeName,
    acpxSessionId: "sid-" + closeName,
    name: closeName,
  }) + "\n");
  process.exit(0);
}

if (command === "prompt") {
  const stdinText = fs.readFileSync(0, "utf8");
  writeLog({ kind: "prompt", agent, args, sessionName: sessionFromOption, stdinText });
  const acpxSessionId = "sid-" + sessionFromOption;

  if (stdinText.includes("trigger-error")) {
    process.stdout.write(JSON.stringify({
      eventVersion: 1,
      acpxSessionId,
      requestId: "req-1",
      seq: 0,
      stream: "prompt",
      type: "error",
      code: "RUNTIME",
      message: "mock failure",
    }) + "\n");
    process.exit(1);
  }

  if (stdinText.includes("split-spacing")) {
    process.stdout.write(JSON.stringify({
      eventVersion: 1,
      acpxSessionId,
      requestId: "req-1",
      seq: 0,
      stream: "prompt",
      type: "text",
      content: "alpha",
    }) + "\n");
    process.stdout.write(JSON.stringify({
      eventVersion: 1,
      acpxSessionId,
      requestId: "req-1",
      seq: 1,
      stream: "prompt",
      type: "text",
      content: " beta",
    }) + "\n");
    process.stdout.write(JSON.stringify({
      eventVersion: 1,
      acpxSessionId,
      requestId: "req-1",
      seq: 2,
      stream: "prompt",
      type: "text",
      content: " gamma",
    }) + "\n");
    process.stdout.write(JSON.stringify({
      eventVersion: 1,
      acpxSessionId,
      requestId: "req-1",
      seq: 3,
      stream: "prompt",
      type: "done",
      stopReason: "end_turn",
    }) + "\n");
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    eventVersion: 1,
    acpxSessionId,
    requestId: "req-1",
    seq: 0,
    stream: "prompt",
    type: "thought",
    content: "thinking",
  }) + "\n");
  process.stdout.write(JSON.stringify({
    eventVersion: 1,
    acpxSessionId,
    requestId: "req-1",
    seq: 1,
    stream: "prompt",
    type: "tool_call",
    title: "run-tests",
    status: "in_progress",
  }) + "\n");
  process.stdout.write(JSON.stringify({
    eventVersion: 1,
    acpxSessionId,
    requestId: "req-1",
    seq: 2,
    stream: "prompt",
    type: "text",
    content: "echo:" + stdinText.trim(),
  }) + "\n");
  process.stdout.write(JSON.stringify({
    eventVersion: 1,
    acpxSessionId,
    requestId: "req-1",
    seq: 3,
    stream: "prompt",
    type: "done",
    stopReason: "end_turn",
  }) + "\n");
  process.exit(0);
}

writeLog({ kind: "unknown", args });
process.stdout.write(JSON.stringify({
  eventVersion: 1,
  acpxSessionId: "unknown",
  seq: 0,
  stream: "control",
  type: "error",
  code: "USAGE",
  message: "unknown command",
}) + "\n");
process.exit(2);
`;

const tempDirs: string[] = [];

async function createMockRuntime(params?: {
  permissionMode?: ResolvedAcpxPluginConfig["permissionMode"];
  queueOwnerTtlSeconds?: number;
}): Promise<{
  runtime: AcpxRuntime;
  logPath: string;
  config: ResolvedAcpxPluginConfig;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-runtime-test-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "mock-acpx.cjs");
  const logPath = path.join(dir, "calls.log");
  await writeFile(scriptPath, MOCK_CLI_SCRIPT, "utf8");
  await chmod(scriptPath, 0o755);
  process.env.MOCK_ACPX_LOG = logPath;

  const config: ResolvedAcpxPluginConfig = {
    command: scriptPath,
    cwd: dir,
    permissionMode: params?.permissionMode ?? "approve-all",
    nonInteractivePermissions: "fail",
    queueOwnerTtlSeconds: params?.queueOwnerTtlSeconds ?? 0.1,
  };

  return {
    runtime: new AcpxRuntime(config, {
      queueOwnerTtlSeconds: params?.queueOwnerTtlSeconds,
      logger: NOOP_LOGGER,
    }),
    logPath,
    config,
  };
}

async function readLogEntries(logPath: string): Promise<Array<Record<string, unknown>>> {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const raw = await readFile(logPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  delete process.env.MOCK_ACPX_LOG;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 10,
    });
  }
});

describe("AcpxRuntime", () => {
  it("passes the shared ACP adapter contract suite", async () => {
    const fixture = await createMockRuntime();
    await runAcpRuntimeAdapterContract({
      createRuntime: async () => fixture.runtime,
      agentId: "codex",
      successPrompt: "contract-pass",
      errorPrompt: "trigger-error",
      assertSuccessEvents: (events) => {
        expect(events.some((event) => event.type === "done")).toBe(true);
      },
      assertErrorOutcome: ({ events, thrown }) => {
        expect(events.some((event) => event.type === "error") || Boolean(thrown)).toBe(true);
      },
    });

    const logs = await readLogEntries(fixture.logPath);
    expect(logs.some((entry) => entry.kind === "ensure")).toBe(true);
    expect(logs.some((entry) => entry.kind === "status")).toBe(true);
    expect(logs.some((entry) => entry.kind === "set-mode")).toBe(true);
    expect(logs.some((entry) => entry.kind === "set")).toBe(true);
    expect(logs.some((entry) => entry.kind === "cancel")).toBe(true);
    expect(logs.some((entry) => entry.kind === "close")).toBe(true);
  });

  it("ensures sessions and streams prompt events", async () => {
    const { runtime, logPath } = await createMockRuntime({ queueOwnerTtlSeconds: 180 });

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

    expect(events).toContainEqual({
      type: "text_delta",
      text: "thinking",
      stream: "thought",
    });
    expect(events).toContainEqual({
      type: "tool_call",
      text: "run-tests (in_progress)",
    });
    expect(events).toContainEqual({
      type: "text_delta",
      text: "echo:hello world",
      stream: "output",
    });
    expect(events).toContainEqual({
      type: "done",
      stopReason: "end_turn",
    });

    const logs = await readLogEntries(logPath);
    const ensure = logs.find((entry) => entry.kind === "ensure");
    const prompt = logs.find((entry) => entry.kind === "prompt");
    expect(ensure).toBeDefined();
    expect(prompt).toBeDefined();
    expect(Array.isArray(prompt?.args)).toBe(true);
    const promptArgs = (prompt?.args as string[]) ?? [];
    expect(promptArgs).toContain("--ttl");
    expect(promptArgs).toContain("180");
    expect(promptArgs).toContain("--approve-all");
  });

  it("passes a queue-owner TTL by default to avoid long idle stalls", async () => {
    const { runtime, logPath } = await createMockRuntime();
    const handle = await runtime.ensureSession({
      sessionKey: "agent:codex:acp:ttl-default",
      agent: "codex",
      mode: "persistent",
    });

    for await (const _event of runtime.runTurn({
      handle,
      text: "ttl-default",
      mode: "prompt",
      requestId: "req-ttl-default",
    })) {
      // drain
    }

    const logs = await readLogEntries(logPath);
    const prompt = logs.find((entry) => entry.kind === "prompt");
    expect(prompt).toBeDefined();
    const promptArgs = (prompt?.args as string[]) ?? [];
    const ttlFlagIndex = promptArgs.indexOf("--ttl");
    expect(ttlFlagIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs[ttlFlagIndex + 1]).toBe("0.1");
  });

  it("preserves leading spaces across streamed text deltas", async () => {
    const { runtime } = await createMockRuntime();
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
  });

  it("maps acpx error events into ACP runtime error events", async () => {
    const { runtime } = await createMockRuntime();
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
      code: "RUNTIME",
      retryable: undefined,
    });
  });

  it("supports cancel and close using encoded runtime handle state", async () => {
    const { runtime, logPath, config } = await createMockRuntime();
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

    const logs = await readLogEntries(logPath);
    const cancel = logs.find((entry) => entry.kind === "cancel");
    const close = logs.find((entry) => entry.kind === "close");
    expect(cancel?.sessionName).toBe("agent:claude:acp:789");
    expect(close?.sessionName).toBe("agent:claude:acp:789");
  });

  it("exposes control capabilities and runs set-mode/set/status commands", async () => {
    const { runtime, logPath } = await createMockRuntime();
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

    const logs = await readLogEntries(logPath);
    expect(logs.find((entry) => entry.kind === "set-mode")?.mode).toBe("plan");
    expect(logs.find((entry) => entry.kind === "set")?.key).toBe("model");
    expect(logs.find((entry) => entry.kind === "status")).toBeDefined();
  });

  it("skips prompt execution when runTurn starts with an already-aborted signal", async () => {
    const { runtime, logPath } = await createMockRuntime();
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

    const logs = await readLogEntries(logPath);
    expect(events).toEqual([]);
    expect(logs.some((entry) => entry.kind === "prompt")).toBe(false);
  });

  it("does not mark backend unhealthy when a per-session cwd is missing", async () => {
    const { runtime } = await createMockRuntime();
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
    const runtime = new AcpxRuntime(
      {
        command: "/definitely/missing/acpx",
        cwd: process.cwd(),
        permissionMode: "approve-reads",
        nonInteractivePermissions: "fail",
        queueOwnerTtlSeconds: 0.1,
      },
      { logger: NOOP_LOGGER },
    );

    await runtime.probeAvailability();
    expect(runtime.isHealthy()).toBe(false);
  });

  it("marks runtime healthy when command is available", async () => {
    const { runtime } = await createMockRuntime();
    await runtime.probeAvailability();
    expect(runtime.isHealthy()).toBe(true);
  });

  it("returns doctor report for missing command", async () => {
    const runtime = new AcpxRuntime(
      {
        command: "/definitely/missing/acpx",
        cwd: process.cwd(),
        permissionMode: "approve-reads",
        nonInteractivePermissions: "fail",
        queueOwnerTtlSeconds: 0.1,
      },
      { logger: NOOP_LOGGER },
    );

    const report = await runtime.doctor();
    expect(report.ok).toBe(false);
    expect(report.code).toBe("ACP_BACKEND_UNAVAILABLE");
    expect(report.installCommand).toContain("acpx");
  });
});
