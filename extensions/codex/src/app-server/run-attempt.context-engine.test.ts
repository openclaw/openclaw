import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  nativeHookRelayTesting,
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  queueAgentHarnessMessage,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt as runCodexAppServerAttemptImpl } from "./run-attempt.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import { createCodexTestModel } from "./test-support.js";

let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;

type RunCodexAppServerAttemptOptions = NonNullable<
  Parameters<typeof runCodexAppServerAttemptImpl>[1]
>;

function setCodexAppServerClientFactoryForTest(factory: CodexAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunCodexAppServerAttemptOptions = {},
) {
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  return runCodexAppServerAttemptImpl(
    params,
    clientFactory ? { ...options, clientFactory } : options,
  );
}

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function toolResultMessage(payload: unknown, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "bulk_context_probe",
    content: [
      {
        type: "toolResult",
        toolUseId: `call-${timestamp}`,
        output: payload,
      },
    ],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-test",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir || "/tmp/openclaw-codex-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createStartedThreadHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
  const request = vi.fn(async (method: string, params?: unknown) => {
    requests.push({ method, params });
    const override = await requestImpl(method, params);
    if (override !== undefined) {
      return override;
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  });

  setCodexAppServerClientFactoryForTest(
    async () =>
      ({
        request,
        addNotificationHandler: (handler: typeof notify) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
      }) as never,
  );

  return {
    requests,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain(method), {
        interval: 1,
      });
    },
    async notify(notification: CodexServerNotification) {
      await notify(notification);
    },
    async completeTurn(status: "completed" | "failed" = "completed", threadId = "thread-1") {
      await notify({
        method: "turn/completed",
        params: {
          threadId,
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            ...(status === "failed" ? { error: { message: "codex failed" } } : {}),
            items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
          },
        },
      });
    },
  };
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  const engine: ContextEngine = {
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
    },
    bootstrap: vi.fn(async () => ({ bootstrapped: true })),
    assemble: vi.fn(async ({ messages, prompt }) => ({
      messages: [...messages, userMessage(prompt ?? "", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
    })),
    ingest: vi.fn(async () => ({ ingested: true })),
    maintain: vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
    compact: vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    })),
    ...overrides,
  };
  return engine;
}

type MockCallReader = { mock: { calls: unknown[][] } };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireFirstCallArg(mock: unknown, label: string): unknown {
  const call = (mock as MockCallReader).mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} to be called`);
  }
  return call[0];
}

function requireRequestParams(
  harness: ReturnType<typeof createStartedThreadHarness>,
  method: string,
): Record<string, unknown> {
  const request = harness.requests.find((entry) => entry.method === method);
  return requireRecord(request?.params, `${method} params`);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRequestInputTextContains(
  harness: ReturnType<typeof createStartedThreadHarness>,
  expected: string,
): void {
  expect(getRequestInputText(harness)).toContain(expected);
}

function getRequestInputText(harness: ReturnType<typeof createStartedThreadHarness>): string {
  return getRequestInputTextAt(harness, 0);
}

function getRequestInputTextAt(
  harness: ReturnType<typeof createStartedThreadHarness>,
  index: number,
): string {
  const request = harness.requests.filter((entry) => entry.method === "turn/start").at(index);
  const params = requireRecord(request?.params, "turn/start params");
  const input = requireArray(params.input, "turn/start input");
  return input
    .map((entry) => {
      const item = requireRecord(entry, "turn/start input entry");
      return item.type === "text" ? optionalString(item.text) : "";
    })
    .join("\n");
}

function extractRelayIdFromThreadRequest(params: unknown): string {
  const config = (params as { config?: Record<string, unknown> }).config;
  const entries = config?.["hooks.PreToolUse"];
  if (!Array.isArray(entries)) {
    throw new Error("pre-tool hook config missing");
  }
  const command = (entries as Array<{ hooks?: Array<{ command?: string }> }>)
    .flatMap((entry) => entry.hooks ?? [])
    .find((hook) => typeof hook.command === "string")?.command;
  const match = command?.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

type CodexNativeThreadLifecycleEvent = Extract<
  DiagnosticEventPayload,
  { type: "codex.native_thread.lifecycle" }
>;

function collectCodexNativeThreadLifecycleEvents(): {
  events: CodexNativeThreadLifecycleEvent[];
  unsubscribe: () => void;
} {
  const events: CodexNativeThreadLifecycleEvent[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "codex.native_thread.lifecycle") {
      events.push(event);
    }
  });
  return { events, unsubscribe };
}

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  beforeEach(async () => {
    resetDiagnosticEventsForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-context-engine-"));
  });

  afterEach(async () => {
    resetCodexAppServerClientFactoryForTest();
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("bootstraps and assembles non-legacy context before the Codex turn starts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()) as never,
    );
    const openSpy = vi.spyOn(SessionManager, "open");
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;
    params.config = { memory: { citations: "on" } } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (!contextEngine.bootstrap) {
      throw new Error("expected bootstrap hook");
    }
    expect(contextEngine.bootstrap).toHaveBeenCalledTimes(1);
    const bootstrapParams = requireFirstCallArg(contextEngine.bootstrap, "bootstrap") as Parameters<
      NonNullable<ContextEngine["bootstrap"]>
    >[0];
    expect(bootstrapParams.sessionId).toBe("session-1");
    expect(bootstrapParams.sessionKey).toBe("agent:main:session-1");
    expect(bootstrapParams.sessionFile).toBe(sessionFile);

    expect(contextEngine.assemble).toHaveBeenCalledTimes(1);
    const assembleParams = requireFirstCallArg(contextEngine.assemble, "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.sessionId).toBe("session-1");
    expect(assembleParams.sessionKey).toBe("agent:main:session-1");
    expect(assembleParams.tokenBudget).toBe(400_000);
    expect(assembleParams.citationsMode).toBe("on");
    expect(assembleParams.model).toBe("gpt-5.4-codex");
    expect(assembleParams.prompt).toBe("hello");
    expect(assembleParams.messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(assembleParams.availableTools).toEqual(new Set());

    const threadStartParams = requireRequestParams(harness, "thread/start");
    expect(optionalString(threadStartParams.developerInstructions)).toContain(
      "context-engine system",
    );
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");

    await harness.completeTurn();
    await run;
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("keeps context-engine history bound to the run session when sandbox key differs", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("canonical main context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.sessionKey = "agent:main:main";
    params.sandboxSessionKey = "agent:main:telegram:default:direct:12345";
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (!contextEngine.bootstrap) {
      throw new Error("expected bootstrap hook");
    }
    const bootstrapParams = requireFirstCallArg(contextEngine.bootstrap, "bootstrap") as Parameters<
      NonNullable<ContextEngine["bootstrap"]>
    >[0];
    expect(bootstrapParams.sessionKey).toBe("agent:main:main");

    const assembleParams = requireFirstCallArg(contextEngine.assemble, "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.sessionKey).toBe("agent:main:main");

    await harness.completeTurn();
    await run;
  });

  it("uses the runtime token budget for large Codex context-engine projections", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const longContext = `large LCM context start ${"x".repeat(30_000)} LARGE_CONTEXT_END`;
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [assistantMessage(longContext, 10)],
        estimatedTokens: 10_000,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeGreaterThan(30_000);
    expect(inputText).toContain("LARGE_CONTEXT_END");
    expect(inputText).not.toContain("[truncated ");

    await harness.completeTurn();
    await run;
  });

  it("uses configured compaction reserve when sizing Codex context-engine projections", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const longContext = `configured reserve context start ${"x".repeat(30_000)} CONFIG_END`;
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [assistantMessage(longContext, 10)],
        estimatedTokens: 10_000,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;
    params.config = {
      agents: { defaults: { compaction: { reserveTokens: 60_000, reserveTokensFloor: 0 } } },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("configured reserve context start");
    expect(inputText).toContain("[truncated ");
    expect(inputText).not.toContain("CONFIG_END");

    await harness.completeTurn();
    await run;
  });

  it("projects thread-bootstrap context only once for a matching context-engine epoch", async () => {
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("bootstrap-only context", Date.now()) as never,
    );
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ messages, prompt }) => ({
        messages: [...messages, userMessage(prompt ?? "", 10)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
      })),
    });
    const firstHarness = createStartedThreadHarness();
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.contextEngine = contextEngine;

    const firstRun = runCodexAppServerAttempt(firstParams);
    await firstHarness.waitForMethod("turn/start");
    expectRequestInputTextContains(firstHarness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(firstHarness, "bootstrap-only context");
    await firstHarness.completeTurn();
    await firstRun;

    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine?.projection).toEqual({
      schemaVersion: 1,
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: undefined,
    });

    const secondHarness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-1");
      }
      return undefined;
    });
    const secondRun = runCodexAppServerAttempt(firstParams);
    await secondHarness.waitForMethod("turn/start");

    expect(secondHarness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    const secondInputText = getRequestInputText(secondHarness);
    expect(secondInputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(secondInputText).not.toContain("bootstrap-only context");
    expect(secondInputText).toBe("hello");
    const projectionLogs = info.mock.calls.filter(
      ([message]) => message === "codex app-server context-engine projection decision",
    );
    expect(projectionLogs).toEqual([
      [
        "codex app-server context-engine projection decision",
        expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          engineId: "lossless-claw",
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          projected: true,
          reason: "missing-thread-binding",
        }),
      ],
      [
        "codex app-server context-engine projection decision",
        expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          engineId: "lossless-claw",
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          previousThreadId: "thread-1",
          previousEpoch: "epoch-1",
          projected: false,
          reason: "matching-thread-bootstrap-binding",
        }),
      ],
    ]);

    await secondHarness.completeTurn();
    await secondRun;
  });

  it.each([
    [
      "token",
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 300_000,
            },
          },
        },
      })}\n`,
      "1mb",
    ],
    ["byte", "x".repeat(2_000), 1_000],
  ] as const)(
    "resumes a matching thread-bootstrap binding even when the bootstrap turn exceeded the native %s guard",
    async (guard, rolloutContent, maxActiveTranscriptBytes) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-bootstrapped",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-1",
          },
        },
      });
      await fs.writeFile(
        path.join(path.dirname(sessionFile), "sessions.json"),
        JSON.stringify({
          "agent:main:session-1": {
            sessionFile,
            totalTokens: 12_000,
          },
        }),
      );
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-bootstrapped.jsonl"),
        rolloutContent,
      );
      const contextEngine = createContextEngine({
        assemble: vi.fn(async ({ prompt }) => ({
          messages: [
            assistantMessage("already bootstrapped context", 10),
            userMessage(prompt ?? "", 11),
          ],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
        })),
      });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-bootstrapped");
        }
        if (method === "thread/start") {
          return threadStartResult("thread-fresh");
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = agentDir;
      params.contextEngine = contextEngine;
      params.config = {
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes,
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];
      const lifecycleDiagnostics = collectCodexNativeThreadLifecycleEvents();

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      expect(harness.requests.map((request) => request.method)).toEqual([
        "thread/resume",
        "turn/start",
      ]);
      const inputText = getRequestInputText(harness);
      expect(inputText).not.toContain("OpenClaw assembled context for this turn:");
      expect(inputText).not.toContain("already bootstrapped context");
      expect(inputText).toBe("hello");

      await harness.completeTurn("completed", "thread-bootstrapped");
      await run;
      await waitForDiagnosticEventsDrained();
      lifecycleDiagnostics.unsubscribe();

      expect(lifecycleDiagnostics.events).toContainEqual(
        expect.objectContaining({
          type: "codex.native_thread.lifecycle",
          action: "reused",
          reason: "thread-bootstrap-semantic-reuse",
          threadId: "thread-bootstrapped",
          bindingMode: "thread_bootstrap",
          projectionEpoch: "epoch-1",
          semanticReuse: true,
        }),
      );
      const guardReason = guard === "token" ? "native-token-guard" : "native-byte-guard";
      expect(lifecycleDiagnostics.events.some((event) => event.reason === guardReason)).toBe(false);
    },
  );

  it("projects mirrored history when an oversized thread-bootstrap binding has no active context engine", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(
      userMessage("previous stale-bootstrap request", Date.now()) as never,
    );
    sessionManager.appendMessage(
      assistantMessage("previous stale-bootstrap answer", Date.now() + 1) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-stale-bootstrap",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-stale",
        },
      },
    });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-stale-bootstrap.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 300_000,
            },
          },
        },
      })}\n`,
    );
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-stale-bootstrap");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("previous stale-bootstrap request");
    expect(inputText).toContain("previous stale-bootstrap answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("hello");

    await harness.completeTurn("completed", "thread-fresh");
    await run;
  });

  it("starts a fresh Codex thread and reprojects when context-engine epoch changes", async () => {
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-old",
        },
      },
    });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-old.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 86_000,
            },
          },
        },
      })}\n`,
    );
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("new epoch context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-new" },
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.contextEngine = contextEngine;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    const lifecycleDiagnostics = collectCodexNativeThreadLifecycleEvents();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, "new epoch context");

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    await run;
    await waitForDiagnosticEventsDrained();
    lifecycleDiagnostics.unsubscribe();

    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
    expect(savedBinding?.contextEngine?.projection?.epoch).toBe("epoch-new");
    expect(info).toHaveBeenCalledWith(
      "codex app-server context-engine projection decision",
      expect.objectContaining({
        sessionId: "session-1",
        engineId: "lossless-claw",
        epoch: "epoch-new",
        previousThreadId: "thread-old",
        previousEpoch: "epoch-old",
        projected: true,
        reason: "projection-mismatch",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "codex app-server wrote context-engine thread binding",
      expect.objectContaining({
        sessionId: "session-1",
        threadId: "thread-new",
        engineId: "lossless-claw",
        epoch: "epoch-new",
        action: "rotated",
      }),
    );
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "rotated",
        reason: "projection-mismatch",
        threadId: "thread-old",
        bindingMode: "thread_bootstrap",
        previousProjectionEpoch: "epoch-old",
        projectionEpoch: "epoch-new",
      }),
    );
    expect(
      lifecycleDiagnostics.events.some(
        (event) => event.reason === "thread-bootstrap-semantic-reuse",
      ),
    ).toBe(false);
  });

  it("reprojects thread-bootstrap context when context-engine policy changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("policy changed context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;
    const lifecycleDiagnostics = collectCodexNativeThreadLifecycleEvents();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, "policy changed context");

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    await run;
    await waitForDiagnosticEventsDrained();
    lifecycleDiagnostics.unsubscribe();
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "rotated",
        reason: "context-engine-binding-mismatch",
        threadId: "thread-old",
        bindingMode: "thread_bootstrap",
        previousProjectionEpoch: "epoch-1",
        projectionEpoch: "epoch-1",
      }),
    );
  });

  it("reprojects thread-bootstrap context for native-disabled transient Codex threads", async () => {
    const restoreSandboxBackend = registerSandboxBackend(
      "codex-context-test-sandbox",
      async () => ({
        id: "codex-context-test-sandbox",
        runtimeId: "codex-context-test-runtime",
        runtimeLabel: "Codex Context Test Sandbox",
        workdir: "/workspace",
        buildExecSpec: async () => ({
          argv: ["true"],
          env: {},
          stdinMode: "pipe-closed" as const,
        }),
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-old",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-1",
          },
        },
      });
      const contextEngine = createContextEngine({
        assemble: vi.fn(async ({ prompt }) => ({
          messages: [
            assistantMessage("native-disabled context", 10),
            userMessage(prompt ?? "", 11),
          ],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
        })),
      });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/start") {
          return threadStartResult("thread-transient");
        }
        if (method === "thread/resume") {
          throw new Error("native-disabled turns should not resume the previous Codex thread");
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      params.contextEngine = contextEngine;
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-context-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];

      let runError: unknown;
      const run = runCodexAppServerAttempt(params).catch((error: unknown) => {
        runError = error;
        throw error;
      });
      await vi.waitFor(
        () => {
          if (runError) {
            throw runError;
          }
          expect(harness.requests.map((request) => request.method)).toContain("turn/start");
        },
        { interval: 1 },
      );

      expect(harness.requests.map((request) => request.method)).toEqual([
        "thread/start",
        "turn/start",
      ]);
      expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
      expectRequestInputTextContains(harness, "native-disabled context");

      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-transient",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "transient answer" }],
          },
        },
      });
      await run;
    } finally {
      restoreSandboxBackend();
    }
  });

  it("reprojects compacted context for native-disabled transient Codex threads", async () => {
    const restoreSandboxBackend = registerSandboxBackend(
      "codex-context-test-sandbox",
      async () => ({
        id: "codex-context-test-sandbox",
        runtimeId: "codex-context-test-runtime",
        runtimeLabel: "Codex Context Test Sandbox",
        workdir: "/workspace",
        buildExecSpec: async () => ({
          argv: ["true"],
          env: {},
          stdinMode: "pipe-closed" as const,
        }),
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const successorFile = path.join(tempDir, "session.compacted.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-old",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":16000,"projectionMaxChars":32000}',
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-before",
          },
        },
      });
      const hugePayload = {
        rows: Array.from({ length: 10 }, (_, index) => ({
          id: index,
          body: "0123456789abcdef".repeat(4000),
        })),
      };
      const compact = vi.fn<ContextEngine["compact"]>(async () => {
        SessionManager.open(successorFile).appendMessage(
          assistantMessage("compacted native-disabled context", Date.now()) as never,
        );
        await writeCodexAppServerBinding(successorFile, {
          threadId: "thread-successor",
          cwd: workspaceDir,
          dynamicToolsFingerprint: "[]",
          contextEngine: {
            schemaVersion: 1,
            engineId: "lossless-claw",
            policyFingerprint:
              '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":16000,"projectionMaxChars":32000}',
            projection: {
              schemaVersion: 1,
              mode: "thread_bootstrap",
              epoch: "epoch-after",
            },
          },
        });
        return {
          ok: true,
          compacted: true,
          result: {
            summary: "summary",
            firstKeptEntryId: "entry-1",
            tokensBefore: 100_000,
            sessionId: "session-1-compacted",
            sessionFile: successorFile,
          },
        };
      });
      const assemble = vi
        .fn<ContextEngine["assemble"]>()
        .mockResolvedValueOnce({
          messages: Array.from({ length: 8 }, (_, index) =>
            toolResultMessage(hugePayload, index + 1),
          ),
          estimatedTokens: 100_000,
          contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
        })
        .mockResolvedValueOnce({
          messages: [assistantMessage("compacted native-disabled context", 2) as never],
          estimatedTokens: 100,
          contextProjection: { mode: "thread_bootstrap", epoch: "epoch-after" },
        });
      const contextEngine = createContextEngine({ assemble, compact });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/start") {
          return threadStartResult("thread-transient");
        }
        if (method === "thread/resume") {
          throw new Error("native-disabled turns should not resume the previous Codex thread");
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      params.contextEngine = contextEngine;
      params.contextTokenBudget = 16_000;
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-context-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      expect(compact).toHaveBeenCalledTimes(1);
      expect(assemble).toHaveBeenCalledTimes(2);
      expect(harness.requests.map((request) => request.method)).toEqual([
        "thread/start",
        "turn/start",
      ]);
      expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
      expectRequestInputTextContains(harness, "compacted native-disabled context");

      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-transient",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "transient answer" }],
          },
        },
      });
      await run;
    } finally {
      restoreSandboxBackend();
    }
  });

  it("starts a fresh Codex thread when thread-bootstrap projection falls back to per-turn projection", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("per-turn context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, "per-turn context");

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    await run;

    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
    expect(savedBinding?.contextEngine?.projection).toBeUndefined();
  });

  it("retries a resumed context-engine thread on a fresh Codex thread after early context overflow", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const successorFile = path.join(tempDir, "session.compacted.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    let epoch = "epoch-before";
    const compact = vi.fn(async () => {
      epoch = "epoch-after";
      SessionManager.open(successorFile).appendMessage(
        assistantMessage("successor compacted context", Date.now()) as never,
      );
      await writeCodexAppServerBinding(successorFile, {
        threadId: "thread-successor",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-after",
          },
        },
      });
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 10,
          sessionId: "session-1-compacted",
          sessionFile: successorFile,
        },
      };
    });
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [
          ...messages,
          assistantMessage(`context ${epoch}`, 10),
          userMessage(prompt ?? "", 11),
        ],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      const request = requireRecord(requestParams, `${method} params`);
      if (method === "thread/resume") {
        const threadId = typeof request.threadId === "string" ? request.threadId : "thread-old";
        return threadStartResult(threadId);
      }
      if (method === "turn/start" && request.threadId === "thread-old") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (
        method === "turn/start" &&
        (request.threadId === "thread-fresh" || request.threadId === "thread-successor")
      ) {
        return turnStartResult("turn-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;
    const lifecycleDiagnostics = collectCodexNativeThreadLifecycleEvents();

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(harness.requests.map((request) => request.method)).toEqual([
        "thread/resume",
        "turn/start",
        "thread/start",
        "turn/start",
      ]),
    );
    expect(queueAgentHarnessMessage("session-1", "operator steering", { debounceMs: 0 })).toBe(
      true,
    );
    await vi.waitFor(() =>
      expect(harness.requests.map((request) => request.method)).toContain("turn/steer"),
    );
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-fresh",
        turnId: "turn-fresh",
        turn: {
          id: "turn-fresh",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    const result = await run;
    await waitForDiagnosticEventsDrained();
    lifecycleDiagnostics.unsubscribe();

    expect(result.assistantTexts).toContain("fresh answer");
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        tokenBudget: 400_000,
        currentTokenCount: 400_000,
        compactionTarget: "threshold",
        force: true,
      }),
    );
    expect(assemble).toHaveBeenCalledTimes(2);
    const retryAssembleParams = assemble.mock.calls[1]?.[0];
    expect(retryAssembleParams?.messages.map((message) => message.role)).toEqual(["assistant"]);
    const retryAssembleMessageTexts = retryAssembleParams?.messages.map((message) => {
      if (!("content" in message) || !Array.isArray(message.content)) {
        return "";
      }
      const firstContent = message.content[0];
      return typeof firstContent === "object" && firstContent !== null && "text" in firstContent
        ? firstContent.text
        : "";
    });
    expect(retryAssembleMessageTexts).toEqual(["successor compacted context"]);
    const retryInputText = getRequestInputTextAt(harness, -1);
    expect(retryInputText).toContain("successor compacted context");
    expect(retryInputText).toContain("context epoch-after");
    expect(retryInputText).toContain("Current user request:\nhello");
    expect(retryInputText).not.toContain("pre-compaction context");
    const savedBinding = await readCodexAppServerBinding(successorFile);
    expect(savedBinding?.threadId).toBe("thread-fresh");
    expect(savedBinding?.contextEngine?.engineId).toBe("lossless-claw");
    expect(savedBinding?.contextEngine?.projection?.epoch).toBe("epoch-after");
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "rotated",
        reason: "app-server-rejected-thread",
        threadId: "thread-old",
        sessionId: "session-1-compacted",
      }),
    );
    expect(lifecycleDiagnostics.events).not.toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "reused",
        reason: "thread-bootstrap-semantic-reuse",
        threadId: "thread-successor",
        sessionId: "session-1-compacted",
        bindingMode: "thread_bootstrap",
        contextEngineId: "lossless-claw",
        projectionEpoch: "epoch-after",
        semanticReuse: true,
      }),
    );
  });

  it("defers provider-boundary compaction after a fresh semantic-reuse thread start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":16000,"projectionMaxChars":32000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => {
      throw new Error("post-start compaction should be handled by the outer retry loop");
    });
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockResolvedValueOnce({
        messages: [assistantMessage("already bootstrapped context", 10)],
        estimatedTokens: 100,
        systemPromptAddition: "bootstrapped context instructions",
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-1" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 8 }, (_, index) =>
          toolResultMessage(hugePayload, index + 1),
        ),
        estimatedTokens: 100_000,
        systemPromptAddition: "fresh thread context instructions",
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-1" },
      });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        throw new Error("stale Codex thread missing");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    const result = await runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });

    expect(result.promptError).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery?.route).not.toBe("fits");
    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/start",
      "thread/unsubscribe",
    ]);
  });

  it("compacts over-budget rendered context-engine prompts before Codex turn/start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 8 }, (_, index) =>
          toolResultMessage(hugePayload, index + 1),
        ),
        estimatedTokens: 100_000,
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage("successor compacted context", 2) as never],
        estimatedTokens: 100,
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-after" },
      });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("successor compacted context");
    expect(inputText).not.toContain("0123456789abcdef");

    await harness.completeTurn();
    const result = await run;
    expect(result.assistantTexts).toContain("final answer");
  });

  it("prechecks owning per-turn context-engine prompts before Codex turn/start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const hugeInstructions = "per-turn context addition ".repeat(50_000);
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockResolvedValueOnce({
        messages: [assistantMessage("large per-turn context", 1) as never],
        estimatedTokens: 100_000,
        systemPromptAddition: hugeInstructions,
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage("successor compacted context", 2) as never],
        estimatedTokens: 100,
        systemPromptAddition: "compacted context system",
      });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(2);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("successor compacted context");
    expect(
      optionalString(requireRequestParams(harness, "thread/start").developerInstructions),
    ).toContain("compacted context system");

    await harness.completeTurn();
    await run;
  });

  it("does not submit a known-overflow context-engine prompt after compaction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const successorSessionFile = path.join(tempDir, "session-compacted.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100_000,
        tokensAfter: 12_345.8,
        sessionId: "session-1-compacted",
        sessionFile: successorSessionFile,
      },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: Array.from({ length: 8 }, (_, index) => toolResultMessage(hugePayload, index + 1)),
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    const result = await runCodexAppServerAttempt(params);

    expect(result.promptError).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery).toBeDefined();
    expect(result.preflightRecovery?.route).not.toBe("fits");
    expect(result.sessionIdUsed).toBe("session-1-compacted");
    expect(result.sessionFileUsed).toBe(successorSessionFile);
    expect(result.compactionCount).toBe(1);
    expect(result.compactionTokensAfter).toBe(12_345);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
  });

  it("does not submit a known-overflow context-engine prompt when compaction is a no-op", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: false,
      result: { summary: "unchanged", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: Array.from({ length: 8 }, (_, index) => toolResultMessage(hugePayload, index + 1)),
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;
    params.abortSignal = abortController.signal;

    const result = await runCodexAppServerAttempt(params);

    expect(result.promptError).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
    expect(result.promptErrorSource).toBe("precheck");
    expect(result.preflightRecovery).toBeDefined();
    expect(result.preflightRecovery?.route).not.toBe("fits");
    expect(result.sessionIdUsed).toBe("session-1");
    expect(result.sessionFileUsed).toBe(sessionFile);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
  });

  it("propagates upstream aborts during provider-boundary context-engine compaction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    let markCompactStarted!: () => void;
    const compactStarted = new Promise<void>((resolve) => {
      markCompactStarted = resolve;
    });
    const compact = vi.fn<ContextEngine["compact"]>(
      async ({ abortSignal }) =>
        await new Promise<Awaited<ReturnType<ContextEngine["compact"]>>>((resolve, reject) => {
          markCompactStarted();
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: Array.from({ length: 8 }, (_, index) => toolResultMessage(hugePayload, index + 1)),
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    const abortController = new AbortController();
    const removeListener = vi.spyOn(abortController.signal, "removeEventListener");
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;
    params.abortSignal = abortController.signal;

    const run = runCodexAppServerAttempt(params);
    await compactStarted;
    abortController.abort(new Error("user abort"));
    const result = await run;

    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
    expect(result.promptError).toBeUndefined();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(harness.requests.map((request) => request.method)).not.toContain("turn/start");
  });

  it("surfaces first-turn Codex context overflow when the precheck fits", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: [assistantMessage("large projected context", 10)],
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex ran out of room in the model's context window",
    );

    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
  });

  it("resumes a preserved thread-bootstrap binding after context-engine successor rollover when projection identity still matches", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const successorFile = path.join(tempDir, "session.compacted.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":16000,"projectionMaxChars":32000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-stable",
        },
      },
    });
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => {
      SessionManager.open(successorFile).appendMessage(
        assistantMessage("successor compacted context", Date.now()) as never,
      );
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 100_000,
          sessionId: "session-1-compacted",
          sessionFile: successorFile,
        },
      };
    });
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 8 }, (_, index) =>
          toolResultMessage(hugePayload, index + 1),
        ),
        estimatedTokens: 100_000,
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage("successor compacted context", 2) as never],
        estimatedTokens: 100,
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-stable" },
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage("fresh run context should stay bootstrapped", 3) as never],
        estimatedTokens: 100,
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-stable" },
      });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;
    const lifecycleDiagnostics = collectCodexNativeThreadLifecycleEvents();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("hello");
    expect(inputText).not.toContain("successor compacted context");
    expect(inputText).not.toContain("0123456789abcdef");

    await harness.completeTurn("completed", "thread-old");
    const result = await run;
    await waitForDiagnosticEventsDrained();
    lifecycleDiagnostics.unsubscribe();

    expect(result.assistantTexts).toContain("final answer");
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    const successorBinding = await readCodexAppServerBinding(successorFile);
    expect(successorBinding?.threadId).toBe("thread-old");
    expect(successorBinding?.contextEngine?.projection?.epoch).toBe("epoch-stable");
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "preserved",
        reason: "context-engine-compaction-preserved-binding",
        threadId: "thread-old",
        sessionId: "session-1-compacted",
        bindingMode: "thread_bootstrap",
        compactionRolledOver: true,
      }),
    );
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "reused",
        reason: "thread-bootstrap-semantic-reuse",
        threadId: "thread-old",
        sessionId: "session-1-compacted",
        sessionFile: "session.compacted.jsonl",
        bindingMode: "thread_bootstrap",
        projectionEpoch: "epoch-stable",
        semanticReuse: true,
      }),
    );
    expect(lifecycleDiagnostics.events).not.toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        reason: "native-token-guard",
        threadId: "thread-old",
      }),
    );

    const secondHarness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      return undefined;
    });
    const secondParams = createParams(successorFile, workspaceDir);
    secondParams.contextEngine = contextEngine;
    secondParams.contextTokenBudget = 16_000;

    const secondRun = runCodexAppServerAttempt(secondParams);
    await secondHarness.waitForMethod("turn/start");

    expect(secondHarness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    const secondInputText = getRequestInputText(secondHarness);
    expect(secondInputText).toBe("hello");
    expect(secondInputText).not.toContain("fresh run context should stay bootstrapped");

    await secondHarness.completeTurn("completed", "thread-old");
    await secondRun;
  });

  it("rotates a preserved thread-bootstrap binding after rollover when projection fingerprint changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const successorFile = path.join(tempDir, "session.compacted.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":16000,"projectionMaxChars":32000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-stable",
          fingerprint: "fingerprint-before",
        },
      },
    });
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => {
      SessionManager.open(successorFile).appendMessage(
        assistantMessage("successor compacted context", Date.now()) as never,
      );
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 100_000,
          sessionId: "session-1-compacted",
          sessionFile: successorFile,
        },
      };
    });
    const assemble = vi
      .fn<ContextEngine["assemble"]>()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 8 }, (_, index) =>
          toolResultMessage(hugePayload, index + 1),
        ),
        estimatedTokens: 100_000,
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage("successor compacted context", 2) as never],
        estimatedTokens: 100,
        contextProjection: {
          mode: "thread_bootstrap",
          epoch: "epoch-stable",
          fingerprint: "fingerprint-after",
        },
      });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;
    const lifecycleDiagnostics = collectCodexNativeThreadLifecycleEvents();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(2);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("successor compacted context");
    expect(inputText).not.toContain("0123456789abcdef");

    await harness.completeTurn("completed", "thread-new");
    const result = await run;
    await waitForDiagnosticEventsDrained();
    lifecycleDiagnostics.unsubscribe();

    expect(result.assistantTexts).toContain("final answer");
    const successorBinding = await readCodexAppServerBinding(successorFile);
    expect(successorBinding?.threadId).toBe("thread-new");
    expect(successorBinding?.contextEngine?.projection?.epoch).toBe("epoch-stable");
    expect(successorBinding?.contextEngine?.projection?.fingerprint).toBe("fingerprint-after");
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "preserved",
        reason: "context-engine-compaction-preserved-binding",
        threadId: "thread-old",
        sessionId: "session-1-compacted",
        bindingMode: "thread_bootstrap",
        compactionRolledOver: true,
      }),
    );
    expect(lifecycleDiagnostics.events).toContainEqual(
      expect.objectContaining({
        type: "codex.native_thread.lifecycle",
        action: "rotated",
        reason: "projection-mismatch",
        threadId: "thread-old",
        sessionId: "session-1-compacted",
        bindingMode: "thread_bootstrap",
        projectionEpoch: "epoch-stable",
        projectionFingerprint: "fingerprint-after",
        previousProjectionEpoch: "epoch-stable",
        previousProjectionFingerprint: "fingerprint-before",
      }),
    );
  });

  it("bounds a hung owning context-engine compaction during Codex overflow recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    // Owning-engine compaction that never settles. The safety timeout keeps the
    // overflow-recovery turn moving and lets the fresh-thread retry proceed.
    const compact = vi.fn<ContextEngine["compact"]>(() => new Promise(() => {}));
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      const request = requireRecord(requestParams, `${method} params`);
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start" && request.threadId === "thread-old") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (method === "turn/start" && request.threadId === "thread-fresh") {
        return turnStartResult("turn-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;
    params.config = {
      agents: { defaults: { compaction: { timeoutSeconds: 1 } } },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.requests.map((request) => request.method)).toEqual([
          "thread/resume",
          "turn/start",
          "thread/start",
          "turn/start",
        ]),
      { timeout: 4_000 },
    );
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-fresh",
        turnId: "turn-fresh",
        turn: {
          id: "turn-fresh",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    const result = await run;

    expect(result.assistantTexts).toContain("fresh answer");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("keeps current inbound context at the front of the Codex context-engine prompt", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("older context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.currentInboundContext = {
      text: [
        "Conversation context (untrusted, chronological, selected for current message):",
        "#6474 Sun 2026-05-10 22:22 GMT+5:30 [reply target] OpenClaw: anchor REPLYCTX this is the old message",
        "#6498 Sun 2026-05-10 22:22 GMT+5:30 OpenClaw: filler REPLYCTX 23",
      ].join("\n"),
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("Current user request:\nhello");
    expect(inputText).toContain("[reply target] OpenClaw: anchor REPLYCTX");
    expect(inputText.trim().startsWith("Conversation context (untrusted")).toBe(true);

    await harness.completeTurn();
    await run;
  });

  it("calls afterTurn with the mirrored transcript and runs turn maintenance", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnCall = requireFirstCallArg(afterTurn, "afterTurn") as Parameters<
      NonNullable<ContextEngine["afterTurn"]>
    >[0];
    expect(afterTurnCall.sessionId).toBe("session-1");
    expect(afterTurnCall.sessionKey).toBe("agent:main:session-1");
    expect(afterTurnCall.prePromptMessageCount).toBe(0);
    expect(afterTurnCall.tokenBudget).toBe(400_000);
    expect(afterTurnCall.messages.some((message) => message.role === "user")).toBe(true);
    expect(afterTurnCall.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("reloads mirrored history after bootstrap mutates the session transcript", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()) as never,
    );
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const bootstrap = vi.fn(
      async ({ sessionFile: file }: Parameters<NonNullable<ContextEngine["bootstrap"]>>[0]) => {
        SessionManager.open(file).appendMessage(
          assistantMessage("bootstrap context", Date.now() + 1) as never,
        );
        return { bootstrapped: true };
      },
    );
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      maintain: undefined,
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const assembleParams = requireFirstCallArg(contextEngine.assemble, "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
    ]);
    const afterTurnParams = requireFirstCallArg(afterTurn, "afterTurn") as Parameters<
      NonNullable<ContextEngine["afterTurn"]>
    >[0];
    expect(afterTurnParams.prePromptMessageCount).toBe(2);
    expectRequestInputTextContains(harness, "bootstrap context");
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const rawError = new Error("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => {
        throw rawError;
      }),
      bootstrap: undefined,
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    const details = requireRecord(warning?.[1], "assemble warning details");
    expect(typeof details.error).toBe("string");
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String(details.error)).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("falls back to ingestBatch and skips turn maintenance on prompt failure", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 2 }));
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({
      afterTurn: undefined,
      ingestBatch,
      maintain,
      bootstrap: undefined,
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn("failed");
    await run;

    expect(ingestBatch).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
  });
});
