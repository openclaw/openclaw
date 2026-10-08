import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createCurrentInputContinuityHarness,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  makeThreadBootstrapBinding,
  requestMethodsExcludingSkillDiscovery,
  requireRecord,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

const CODEX_TURN_START_TEXT_INPUT_MAX_CHARS = 1 << 20;

async function createSqliteParams(
  workspaceDir: string,
  storeName: string,
): Promise<EmbeddedRunAttemptParams> {
  const sessionId = "session-1";
  const sessionKey = "agent:main:session-1";
  const storePath = path.join(tempDir, `${storeName}.sqlite`);
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  const params = createParams(sessionFile, workspaceDir);
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    storePath,
    entry: { sessionFile, sessionId, updatedAt: Date.now() },
  });
  params.sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  const message = userMessage("hello", Date.now());
  params.userTurnTranscriptRecorder = {
    message,
    resolveMessage: async () => message,
    markRuntimePersisted() {},
    getAdmissionReceipt: () => undefined,
  } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
  return params;
}

type MockCallReader = { mock: { calls: unknown[][] } };

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

function expectRequestInputTextContains(
  harness: ReturnType<typeof createStartedThreadHarness>,
  expected: string,
): void {
  expect(getRequestInputText(harness)).toContain(expected);
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  it("bootstraps and assembles a compaction summary before the Codex turn starts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    const summary = "The durable code is summary-only-engine-code-8516.";
    const retainedId = sessionManager.appendMessage(
      assistantMessage("ACK: existing context", Date.now()),
    );
    sessionManager.appendCompaction(summary, retainedId, 1_000);
    const openSpy = vi.spyOn(SessionManager, "open");
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "Recall the durable code from our prior work.";
    params.currentInboundContext = { text: "Current inbound reply context" };
    params.contextEngine = contextEngine;
    params.sandboxSessionKey = "agent:main:telegram:default:direct:12345";
    params.contextTokenBudget = 321;
    params.requestedModelId = "gpt-5.4-codex-primary";
    params.fallbackReason = "provider_unavailable";
    params.degradedReason = "context_overflow";
    params.config = { memory: { citations: "on" } } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (!contextEngine.bootstrap) {
      throw new Error("expected bootstrap hook");
    }
    expect(contextEngine["bootstrap"]).toHaveBeenCalledTimes(1);
    const bootstrapParams = requireFirstCallArg(
      contextEngine["bootstrap"],
      "bootstrap",
    ) as Parameters<NonNullable<ContextEngine["bootstrap"]>>[0];
    expect(bootstrapParams.sessionId).toBe("session-1");
    expect(bootstrapParams.sessionKey).toBe("agent:main:session-1");
    expect(bootstrapParams.sessionFile).toBe(sessionFile);
    expect(bootstrapParams.runtimeSettings).toMatchObject({
      runtime: { mode: "degraded" },
      model: {
        requested: "gpt-5.4-codex-primary",
        resolved: "gpt-5.4-codex",
      },
      diagnostics: {
        fallbackReason: "provider_unavailable",
        degradedReason: "context_overflow",
      },
    });

    expect(contextEngine["assemble"]).toHaveBeenCalledTimes(1);
    const assembleParams = requireFirstCallArg(contextEngine["assemble"], "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.sessionId).toBe("session-1");
    expect(assembleParams.sessionKey).toBe("agent:main:session-1");
    expect(assembleParams.tokenBudget).toBe(321);
    expect(assembleParams.citationsMode).toBe("on");
    expect(assembleParams.model).toBe("gpt-5.4-codex");
    expect(assembleParams.runtimeSettings).toMatchObject({
      runtime: { mode: "degraded" },
      model: {
        requested: "gpt-5.4-codex-primary",
        resolved: "gpt-5.4-codex",
      },
      diagnostics: {
        fallbackReason: "provider_unavailable",
        degradedReason: "context_overflow",
      },
    });
    expect(assembleParams.prompt).toBe(params.prompt);
    const summaryRole = "compactionSummary";
    expect(assembleParams.messages.map((message) => message.role)).toEqual([
      summaryRole,
      "assistant",
    ]);
    expect(assembleParams.availableTools).toEqual(new Set());

    const threadStartParams = requireRequestParams(harness, "thread/start");
    expect(readStringValue(threadStartParams.developerInstructions) ?? "").toContain(
      "context-engine system",
    );
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, `[${summaryRole}]\n${summary}`);
    expect(getRequestInputText(harness).trim().startsWith("Current inbound reply context")).toBe(
      true,
    );
    expectRequestInputTextContains(harness, "[assistant]\nACK: existing context");
    expectRequestInputTextContains(
      harness,
      `</conversation_context>\n\nCurrent user request:\n${params.prompt}`,
    );

    await harness.completeTurn();
    await run;
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("keeps current image-only input stable through continuity projection", async () => {
    const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: beforePromptBuild,
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session-current-request.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-current-request");
    const { harness, params, currentUserMessageId } = await createCurrentInputContinuityHarness(
      sessionFile,
      workspaceDir,
      "image-only",
    );

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    const events = beforePromptBuild.mock.calls.map(
      ([event]) =>
        event as {
          currentUserMessage?: string;
          currentUserMessageId?: string;
          prompt?: string;
        },
    );
    expect(events.map((event) => event.currentUserMessage)).toEqual([params.prompt, params.prompt]);
    expect(events.map((event) => event.currentUserMessageId)).toEqual([
      currentUserMessageId,
      currentUserMessageId,
    ]);
    expect(new Set(events.map((event) => event.prompt)).size).toBe(2);
    expect(events.some((event) => event.prompt?.includes("PROJECTED_HISTORY_TAIL"))).toBe(true);
    expect(events.some((event) => event.prompt?.includes("PROJECTED_HISTORY_PREFIX"))).toBe(false);
    const projectedContext = events[1]?.prompt?.match(
      /<conversation_context>\n([\s\S]*?)\n<\/conversation_context>/u,
    )?.[1];
    expect(projectedContext?.length).toBeLessThanOrEqual(450_000);
    expect(events.some((event) => (event.prompt?.length ?? 0) > 100_000)).toBe(true);

    await harness.completeTurn();
    await run;
  });

  it.each(["lazy", "none"] as const)(
    "keeps the admitted input during runtime refresh with recorder: %s",
    async (recorderKind) => {
      const withRecorder = recorderKind !== "none";
      const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_prompt_build",
            handler: beforePromptBuild,
          },
        ]),
      );
      const sessionFile = path.join(tempDir, "session-runtime-refresh.jsonl");
      const workspaceDir = path.join(tempDir, "workspace-runtime-refresh");
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.prompt = "Transport context and media wrapping, or continue after runtime refresh.";
      const admittedMessage = {
        ...userMessage("What do you remember about my preferences?", 10),
        idempotencyKey: "refresh-original:user",
      };
      if (withRecorder) {
        params.userTurnTranscriptRecorder = {
          message: undefined,
          resolveMessage: async () => admittedMessage,
          markRuntimePersisted() {},
          getAdmissionReceipt: () => undefined,
        } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
      }
      params.pluginRuntimeRefreshMessages = [
        admittedMessage,
        assistantMessage("Work completed before refresh.", 20),
      ];

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      expect(beforePromptBuild).toHaveBeenCalled();
      for (const [event] of beforePromptBuild.mock.calls) {
        expect(event).toMatchObject({
          currentUserMessage: withRecorder ? "What do you remember about my preferences?" : "",
        });
        if (withRecorder) {
          expect(event).toHaveProperty("currentUserMessageId", "refresh-original:user");
        } else {
          expect(event).not.toHaveProperty("currentUserMessageId");
        }
      }

      await harness.completeTurn();
      await run;
    },
  );

  it("bounds active context-engine projections when prompt hooks append context", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async (event) => ({
            appendContext: `${(event as { prompt: string }).prompt}\n\nhook append marker`,
            prependContext: "hook prefix context",
          }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [
          ...Array.from({ length: 9 }, (_, index) =>
            assistantMessage(`older context ${index} ${"x".repeat(120_000)}`, index),
          ),
          assistantMessage("recent anchor", 10),
        ],
        estimatedTokens: 300_000,
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 300_000;
    params.prompt = "current prompt survives";
    params.currentInboundContext = { text: "current inbound context survives" };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBe(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("recent anchor");
    expect(inputText).toContain("current inbound context survives");
    expect(inputText).toContain("current prompt survives");
    expect(inputText).toContain("hook append marker");

    await harness.completeTurn();
    await run;
  });

  it("bounds hook-appended prompts after delivery metadata is relocated", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => ({ appendContext: `hook context ${"h".repeat(1_100_000)}` }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session-delivery-hint.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-delivery-hint");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = `${MESSAGE_TOOL_DELIVERY_HINTS[0]}\n\ncurrent prompt survives`;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("Current user request:\ncurrent prompt survives");
    expect(inputText).not.toContain("hook context");

    await harness.completeTurn();
    await run;
  });

  it("bounds hook-appended output for an empty prompt without an active context engine", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => ({
            appendContext: `hook context ${"h".repeat(1_100_000)} hook tail`,
          }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("hook tail");

    await harness.completeTurn();
    await run;
  });

  it.each(["byte guard", "token pressure", "inactive engine"] as const)(
    "preserves bootstrap ownership under %s",
    async (scenario) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const resumed = scenario === "byte guard";
      const active = scenario !== "inactive engine";
      await writeCodexAppServerBinding(
        sessionFile,
        makeThreadBootstrapBinding({
          threadId: "thread-bootstrapped",
          cwd: workspaceDir,
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          epoch: "epoch-1",
        }),
      );
      await fs.writeFile(
        path.join(path.dirname(sessionFile), "sessions.json"),
        JSON.stringify({ "agent:main:session-1": { sessionFile, totalTokens: 12_000 } }),
      );
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-bootstrapped.jsonl"),
        resumed
          ? "x".repeat(2_000)
          : `${JSON.stringify({
              payload: {
                type: "token_count",
                info: active
                  ? { last_token_usage: { total_tokens: 241_198 }, model_context_window: 258_400 }
                  : { last_token_usage: { total_tokens: 300_000 } },
              },
            })}\n`,
      );
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = agentDir;
      if (active) {
        params.contextEngine = createContextEngine({
          assemble: vi.fn(async ({ prompt }) => ({
            messages: [assistantMessage("reprojected context", 10), userMessage(prompt ?? "", 11)],
            estimatedTokens: 42,
            systemPromptAddition: "context-engine system",
            contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
          })),
        });
      } else {
        const manager = openFileBackedSessionManagerForTest(sessionFile, {
          sessionId: "session-1",
        });
        manager.appendMessage(userMessage("previous stale-bootstrap request", Date.now()));
        manager.appendMessage(assistantMessage("previous stale-bootstrap answer", Date.now() + 1));
      }
      if (scenario !== "token pressure") {
        params.config = {
          agents: {
            defaults: { compaction: { maxActiveTranscriptBytes: resumed ? 1_000 : "1mb" } },
          },
        };
      }
      const harness = createStartedThreadHarness(
        async (method) => {
          if (method === "thread/resume") {
            return threadStartResult("thread-bootstrapped");
          }
          if (method === "thread/start") {
            return threadStartResult("thread-fresh");
          }
          return undefined;
        },
        { persistedThreads: resumed ? ["thread-bootstrapped"] : [] },
      );
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
        "config/read",
        "configRequirements/read",
        ...(resumed ? ["thread/read", "thread/resume", "thread/inject_items"] : ["thread/start"]),
        "turn/start",
      ]);
      const inputText = getRequestInputText(harness);
      if (resumed) {
        expect(inputText).toBe("hello");
      } else if (active) {
        expect(inputText).toContain("OpenClaw assembled context for this turn:");
        expect(inputText).toContain("reprojected context");
      } else {
        expect(inputText).not.toContain("OpenClaw assembled context for this turn:");
        expect(inputText).not.toContain("previous stale-bootstrap request");
        expect(inputText).not.toContain("previous stale-bootstrap answer");
        expect(inputText).not.toContain("Current user request:");
        expect(inputText).toContain("hello");
      }
      await harness.completeTurn("completed", resumed ? "thread-bootstrapped" : "thread-fresh");
      await run;
    },
  );

  it("keeps mirrored history when an inactive per-turn context-engine binding starts fresh", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(userMessage("previous per-turn request", 10) as never);
    sessionManager.appendMessage(assistantMessage("previous per-turn answer", 11) as never);
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-per-turn-context",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
      },
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (method === "thread/resume") {
        throw new Error("inactive context-engine bindings should start a fresh thread");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("previous per-turn request");
    expect(inputText).toContain("previous per-turn answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("hello");

    await harness.completeTurn("completed", "thread-fresh");
    await run;
  });

  it.each([
    { change: "policy", previousEpoch: "epoch-1", epoch: "epoch-1", tokenBudget: 80_000 },
    {
      change: "per-turn projection",
      previousEpoch: "epoch-1",
      epoch: undefined,
      tokenBudget: undefined,
    },
  ])(
    "starts fresh and reprojects after a context-engine $change change",
    async ({ previousEpoch, epoch, tokenBudget }) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(
        sessionFile,
        makeThreadBootstrapBinding({
          threadId: "thread-old",
          cwd: workspaceDir,
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          epoch: previousEpoch,
        }),
      );
      const contextEngine = createContextEngine({
        assemble: vi.fn(async ({ prompt }) => ({
          messages: [assistantMessage("reprojected context", 10), userMessage(prompt ?? "", 11)],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: epoch ? { mode: "thread_bootstrap" as const, epoch } : undefined,
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
      params.contextTokenBudget = tokenBudget;

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
        "config/read",
        "configRequirements/read",
        "thread/start",
        "turn/start",
      ]);
      expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
      expectRequestInputTextContains(harness, "reprojected context");
      await harness.completeTurn("completed", "thread-new");
      await run;

      const savedBinding = await readCodexAppServerBinding(sessionFile);
      expect(savedBinding?.threadId).toBe("thread-new");
      if (epoch) {
        expect(savedBinding?.contextEngine?.projection?.epoch).toBe(epoch);
      } else {
        expect(savedBinding?.contextEngine?.projection).toBeUndefined();
      }
    },
  );

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
      await writeCodexAppServerBinding(
        sessionFile,
        makeThreadBootstrapBinding({
          threadId: "thread-old",
          cwd: workspaceDir,
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          epoch: "epoch-1",
        }),
      );
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

      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        harness.waitForMethod("turn/start"),
        run.then(() => {
          throw new Error("Codex attempt completed before turn/start");
        }),
      ]);

      expect(requestMethodsExcludingSkillDiscovery(harness)).toEqual([
        "config/read",
        "thread/start",
        "turn/start",
      ]);
      expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
      expectRequestInputTextContains(harness, "native-disabled context");

      await harness.completeTurn("completed", "thread-transient");
      await run;
    } finally {
      restoreSandboxBackend();
    }
  });

  it.each([
    {
      name: "Gateway-routed heartbeat",
      trigger: "user",
      bootstrapContextRunKind: "heartbeat",
    },
  ] as const)(
    "returns an exact terminal anchor for $name turns without finalizing inside Codex",
    async (testCase) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const afterTurn = vi.fn(
        async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
      );
      const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
      const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
      const harness = createStartedThreadHarness();
      const params = await createSqliteParams(
        workspaceDir,
        `heartbeat-${testCase.bootstrapContextRunKind}`,
      );
      params.contextEngine = contextEngine;
      params.trigger = testCase.trigger;
      params.bootstrapContextRunKind = testCase.bootstrapContextRunKind;
      params.contextTokenBudget = 111;
      params.requestedModelId = "gpt-5.4-codex-primary";
      params.fallbackReason = "provider_unavailable";
      params.degradedReason = "context_overflow";

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn();
      const result = await run;

      expect(result.contextEngineTerminalAnchor).toMatchObject({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      });
      expect(afterTurn).not.toHaveBeenCalled();
      expect(maintain).not.toHaveBeenCalled();
    },
  );

  it("persists the admitted user prompt before an async item buffered during turn startup", async () => {
    const workspaceDir = path.join(tempDir, "workspace-early-async");
    const params = await createSqliteParams(workspaceDir, "early-async-order");
    const delivered = Promise.withResolvers<void>();
    params.onBlockReply = vi.fn(() => delivered.resolve());
    params.sandboxSessionKey = "agent:main:policy";
    params.contextEngine = createContextEngine();
    const beforeMessageWrite = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: beforeMessageWrite }]),
    );
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("expected user turn transcript recorder");
    }
    recorder.markRuntimePersistencePending = vi.fn();
    recorder.markRuntimePersisted = vi.fn();
    recorder.markSentToProvider = vi.fn(() => {
      throw new Error("admission is not available before Codex turn/start");
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "startup-async",
              phase: "final_answer",
              delivery: "async",
              text: "Working on the request.",
            },
          },
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await awaitGateBeforeSettlement(
      delivered.promise,
      run,
      "Codex attempt completed before delivering its buffered async item",
    );
    expect(params.onBlockReply).toHaveBeenCalledOnce();
    expect(recorder.markSentToProvider).not.toHaveBeenCalled();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();
    expect(beforeMessageWrite).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
      { agentId: "main", sessionKey: params.sessionKey },
    );
    await harness.completeTurn();
    await run;

    const sessionTarget = params.sessionTarget;
    if (!sessionTarget?.sessionId || !sessionTarget.sessionKey) {
      throw new Error("expected a complete session transcript target");
    }
    const messages = (
      await readSessionTranscriptEvents({
        ...sessionTarget,
        sessionId: sessionTarget.sessionId,
        sessionKey: sessionTarget.sessionKey,
      })
    )
      .map((event) => (event as { message?: { role?: string } }).message)
      .filter((message) => message !== undefined);
    expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]).toMatchObject({ openclawAsyncDelivery: { itemId: "startup-async" } });
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("first baseline message", 1) as never,
    );
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      userMessage("second baseline message", 2) as never,
    );
    let preassemblyMessages: AgentMessage[] = [];
    let promptHookMessages: AgentMessage[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async (event) => {
            promptHookMessages = (event as { messages: AgentMessage[] }).messages;
            return {};
          },
        },
      ]),
    );
    const rawError = new Error("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ messages }) => {
        preassemblyMessages = messages.slice();
        messages.reverse();
        messages.pop();
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
    expect(promptHookMessages).toEqual(preassemblyMessages);
    expect(promptHookMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expectRequestInputTextContains(harness, params.prompt);
  });
});
