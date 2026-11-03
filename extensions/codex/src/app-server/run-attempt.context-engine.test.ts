import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  requireRecord,
  runCodexAppServerAttempt,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { isCodexTurnContextHandoff } from "./test-support.js";

const CODEX_TURN_START_TEXT_INPUT_MAX_CHARS = 1 << 20;
let sessionFile: string;
let workspaceDir: string;

function attempt(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
  request?: Parameters<typeof createStartedThreadHarness>[0],
) {
  return {
    params: Object.assign(createParams(sessionFile, workspaceDir), overrides),
    harness: createStartedThreadHarness(request),
  };
}

function sessionManager() {
  return openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" });
}

async function startAttempt(
  params: EmbeddedRunAttemptParams,
  harness: ReturnType<typeof createStartedThreadHarness>,
) {
  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  return async (threadId = "thread-1") => {
    await harness.completeTurn("completed", threadId);
    return run;
  };
}

function bootstrapBinding(threadId = "thread-old", epoch = "epoch-1") {
  return makeThreadBootstrapBinding({
    threadId,
    cwd: workspaceDir,
    epoch,
    policyFingerprint:
      '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
  });
}

function projectionAssembly(text: string, epoch: string | undefined) {
  return vi.fn<ContextEngine["assemble"]>(async ({ prompt }) => ({
    messages: [assistantMessage(text, 10), userMessage(prompt ?? "", 11)],
    estimatedTokens: 42,
    systemPromptAddition: "context-engine system",
    contextProjection: epoch ? { mode: "thread_bootstrap" as const, epoch } : undefined,
  }));
}

function promptHook(handler: Parameters<typeof createMockPluginRegistry>[0][number]["handler"]) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_prompt_build", handler }]),
  );
}

const runtimeSettings = {
  runtime: { mode: "degraded" },
  model: { requested: "gpt-5.4-codex-primary", resolved: "gpt-5.4-codex" },
  diagnostics: { fallbackReason: "provider_unavailable", degradedReason: "context_overflow" },
};

async function createSqliteParams(
  sqliteWorkspaceDir: string,
  storeName: string,
): Promise<EmbeddedRunAttemptParams> {
  const sessionId = "session-1";
  const storePath = path.join(tempDir, `${storeName}.sqlite`);
  const sqliteSessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  const params = createParams(sqliteSessionFile, sqliteWorkspaceDir);
  await attachSqliteSessionTarget(params, storePath, sessionId);
  const message = userMessage("hello", Date.now());
  params.userTurnTranscriptRecorder = {
    message,
    resolveMessage: async () => message,
    markRuntimePersisted() {},
    getAdmissionReceipt: () => undefined,
  } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
  return params;
}

setupRunAttemptTestHooks();
beforeEach(() => {
  sessionFile = path.join(tempDir, "session.jsonl");
  workspaceDir = path.join(tempDir, "workspace");
});

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  it.each(["summary", "text budget", "image budget", "no authored cap"] as const)(
    "assembles %s before starting the native turn",
    async (scenario) => {
      const summary = scenario === "summary";
      const contextEngine = createContextEngine();
      const { params, harness } = attempt({
        contextEngine,
        contextTokenBudget: summary ? 321 : 500_000,
      });
      const manager = sessionManager();
      params.currentInboundContext = { text: "Current inbound reply context" };
      if (summary) {
        const retained = manager.appendMessage(
          assistantMessage("ACK: existing context", Date.now()),
        );
        manager.appendCompaction(
          "The durable code is summary-only-engine-code-8516.",
          retained,
          1_000,
        );
        params.prompt = "Recall the durable code.";
        params.sandboxSessionKey = "agent:main:telegram:default:direct:12345";
        params.requestedModelId = "gpt-5.4-codex-primary";
        params.fallbackReason = "provider_unavailable";
        params.degradedReason = "context_overflow";
        params.config = { memory: { citations: "on" } };
        setRuntimeConfigSnapshot(params.config);
      } else {
        manager.appendMessage(userMessage("PRIOR_BUDGET_CONTEXT", 10));
        if (scenario !== "no authored cap") {
          params.authoredContextTokenCap = 600_000;
        }
        if (scenario === "image budget") {
          params.images = [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
            },
          ];
        }
        params.prompt = `CURRENT_REQUEST ${"current ".repeat(1_000).trimEnd()}`;
      }
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      const assembly = vi.mocked(contextEngine, true).assemble.mock.calls[0]?.[0];
      const bootstrap = vi.mocked(contextEngine, true).bootstrap?.mock.calls[0]?.[0];
      const input = getRequestInputText(harness);
      expect(input).toContain(params.prompt);
      expect(input).toContain("Current inbound reply context");
      if (summary) {
        expect(bootstrap).toMatchObject({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          runtimeSettings,
        });
        expect(assembly).toMatchObject({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          tokenBudget: 321,
          citationsMode: "on",
          model: "gpt-5.4-codex",
          runtimeSettings,
          prompt: params.prompt,
          messages: [{ role: "compactionSummary" }, { role: "assistant" }],
        });
        expect(
          harness.requests.find(({ method }) => method === "thread/start")?.params,
        ).toMatchObject({
          developerInstructions: expect.stringContaining("context-engine system"),
        });
        expect(input).toContain(
          "[compactionSummary]\nThe durable code is summary-only-engine-code-8516.",
        );
        expect(input).toContain("[assistant]\nACK: existing context");
        expect(input.trim().startsWith("Current inbound reply context")).toBe(true);
        expect(input).toContain(`Current user request:\n${params.prompt}`);
      } else if (scenario === "no authored cap") {
        expect(assembly?.tokenBudget).toBe(500_000);
        expect(assembly?.runtimeSettings?.limits.promptTokenBudget).toBe(500_000);
        expect(
          harness.requests.some(
            ({ method, params: requestParams }) =>
              method === "thread/inject_items" && !isCodexTurnContextHandoff(requestParams),
          ),
        ).toBe(false);
      } else {
        expect(assembly?.tokenBudget).toBeGreaterThan(0);
        expect(assembly?.tokenBudget).toBeLessThan(480_000);
        expect(assembly?.runtimeSettings?.limits).toMatchObject({
          promptTokenBudget: assembly?.tokenBudget,
          maxOutputTokens: 20_000,
        });
        expect(bootstrap?.runtimeSettings?.limits.promptTokenBudget).toBe(500_000);
        const history = harness.requests.filter(
          ({ method, params: requestParams }) =>
            method === "thread/inject_items" && !isCodexTurnContextHandoff(requestParams),
        );
        expect(history).toHaveLength(1);
        expect(JSON.stringify(history[0]?.params)).toContain("PRIOR_BUDGET_CONTEXT");
        expect(input).not.toContain("PRIOR_BUDGET_CONTEXT");
      }
      await harness.completeTurn();
      await run;
    },
  );

  it("places inert sender provenance beside a continuity-projected request without escaping request mentions", async () => {
    const { harness, params } = await createCurrentInputContinuityHarness(
      sessionFile,
      workspaceDir,
      "text",
    );
    params.prompt = "i am Bea coded wdym $current-skill [@current](plugin://current@market)";
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder?.message) {
      throw new Error("expected admitted current user message");
    }
    const admittedMessage = {
      ...recorder.message,
      content: [{ type: "text" as const, text: params.prompt }],
      __openclaw: {
        senderId: "bea-id",
        senderName: "$deploy",
        senderUsername: "[@probe] (plugin://probe@market)",
      },
    } as AgentMessage;
    params.userTurnTranscriptRecorder = {
      ...recorder,
      message: admittedMessage,
      resolveMessage: async () => admittedMessage,
    } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];

    const finish = await startAttempt(params, harness);

    expect(getRequestInputText(harness)).toContain(
      `Current user request:\n[user sender={"id":"bea-id","name":"＄deploy","username":"[＠probe] (plugin://probe@market)"}]\n${params.prompt}`,
    );
    expect(getRequestInputText(harness)).not.toContain("$deploy");
    expect(getRequestInputText(harness)).not.toContain("[@probe]");

    await finish();
  });

  it("keeps current image-only input stable through continuity projection", async () => {
    const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
    promptHook(beforePromptBuild);

    const { harness, params, currentUserMessageId } = await createCurrentInputContinuityHarness(
      sessionFile,
      workspaceDir,
      "image-only",
    );

    const finish = await startAttempt(params, harness);

    const events = beforePromptBuild.mock.calls.map(
      ([event]) =>
        event as {
          currentUserMessage?: string;
          currentUserMessageId?: string;
          prompt?: string;
        },
    );
    expect(events).toMatchObject([
      { currentUserMessage: params.prompt, currentUserMessageId },
      { currentUserMessage: params.prompt, currentUserMessageId },
    ]);
    expect(new Set(events.map((event) => event.prompt)).size).toBe(2);
    expect(events.some((event) => event.prompt?.includes("PROJECTED_HISTORY_TAIL"))).toBe(true);
    expect(events.some((event) => event.prompt?.includes("PROJECTED_HISTORY_PREFIX"))).toBe(false);
    const projectedContext = events[1]?.prompt?.match(
      /<conversation_context>\n([\s\S]*?)\n<\/conversation_context>/u,
    )?.[1];
    expect(projectedContext?.length).toBeLessThanOrEqual(450_000);
    expect(events.some((event) => (event.prompt?.length ?? 0) > 100_000)).toBe(true);

    await finish();
  });

  it.each(["lazy", "none"] as const)(
    "keeps the admitted input during runtime refresh with recorder: %s",
    async (recorderKind) => {
      const withRecorder = recorderKind !== "none";
      const beforePromptBuild = vi.fn(async (_event: unknown) => undefined);
      promptHook(beforePromptBuild);

      const { harness, params } = attempt();
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

      const finish = await startAttempt(params, harness);

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

      await finish();
    },
  );

  it("bounds hook-appended prompts after delivery metadata is relocated", async () => {
    promptHook(async () => ({ appendContext: `hook context ${"h".repeat(1_100_000)}` }));

    const { harness, params } = attempt();
    params.prompt = `${MESSAGE_TOOL_DELIVERY_HINTS[0]}\n\ncurrent prompt survives`;

    const finish = await startAttempt(params, harness);

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("Current user request:\ncurrent prompt survives");
    expect(inputText).not.toContain("hook context");

    await finish();
  });

  it.each(["byte guard", "token pressure", "inactive engine"] as const)(
    "preserves bootstrap ownership under %s",
    async (scenario) => {
      const agentDir = path.join(tempDir, "agent");
      const resumed = scenario === "byte guard";
      const active = scenario !== "inactive engine";
      await writeCodexAppServerBinding(sessionFile, {
        ...bootstrapBinding("thread-bootstrapped", "epoch-1"),
        model: "gpt-5.4-codex",
        modelProvider: "openai",
      });
      await fs.writeFile(
        path.join(path.dirname(sessionFile), "sessions.json"),
        JSON.stringify({ "agent:main:session-1": { sessionFile, totalTokens: 12_000 } }),
      );
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-bootstrapped.jsonl"),
        [
          ...(resumed
            ? [
                "x".repeat(2_000),
                JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4-codex" } }),
              ]
            : []),
          JSON.stringify({
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { total_tokens: resumed ? 12_000 : active ? 241_198 : 300_000 },
                ...(active ? { model_context_window: 258_400 } : {}),
              },
            },
          }),
          "",
        ].join("\n"),
      );
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = agentDir;
      const assemble = projectionAssembly("reprojected context", "epoch-1");
      if (active) {
        params.contextEngine = createContextEngine({ assemble });
      } else {
        const manager = sessionManager();
        manager.appendMessage(userMessage("previous stale-bootstrap request", Date.now()));
        manager.appendMessage(assistantMessage("previous stale-bootstrap answer", Date.now() + 1));
      }
      if (scenario !== "token pressure") {
        params.config = {
          agents: {
            defaults: { compaction: { maxActiveTranscriptBytes: resumed ? 1_000 : "1mb" } },
          },
        };
        setRuntimeConfigSnapshot(params.config);
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
      const finish = await startAttempt(params, harness);
      const inputText = getRequestInputText(harness);
      if (resumed) {
        expect(inputText).toBe("hello");
        expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 258_400 }));
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
      await finish(resumed ? "thread-bootstrapped" : "thread-fresh");
    },
  );

  it.each(["inactive per-turn", "policy", "per-turn projection", "native-disabled"] as const)(
    "starts fresh with the correct history after %s",
    async (scenario) => {
      const inactive = scenario === "inactive per-turn";
      const transient = scenario === "native-disabled";
      const epoch = scenario === "per-turn projection" ? undefined : "epoch-1";
      const binding = bootstrapBinding();
      if (inactive && binding.contextEngine) {
        delete binding.contextEngine.projection;
        const manager = sessionManager();
        manager.appendMessage(userMessage("previous per-turn request", 10));
        manager.appendMessage(assistantMessage("previous per-turn answer", 11));
      }
      await writeCodexAppServerBinding(sessionFile, binding);
      const { params, harness } = attempt(
        {
          contextEngine: inactive
            ? undefined
            : createContextEngine({ assemble: projectionAssembly("reprojected context", epoch) }),
          contextTokenBudget: scenario === "policy" ? 80_000 : undefined,
        },
        async (method) => {
          if (method === "thread/resume") {
            throw new Error("changed context must start a fresh thread");
          }
          if (method === "thread/start") {
            return threadStartResult("thread-new");
          }
          return undefined;
        },
      );
      let releaseSandbox = () => {};
      if (transient) {
        releaseSandbox = registerSandboxBackend("codex-context-test-sandbox", async () => ({
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
        }));
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
        };
        setRuntimeConfigSnapshot(params.config);
      }
      try {
        const run = runCodexAppServerAttempt(params);
        await Promise.race([
          harness.waitForMethod("turn/start"),
          run.then(() => {
            throw new Error("Codex attempt completed before turn/start");
          }),
        ]);
        const text = getRequestInputText(harness);
        expect(text).toContain("OpenClaw assembled context for this turn:");
        if (inactive) {
          expect(text).toContain("previous per-turn request");
          expect(text).toContain("previous per-turn answer");
          expect(text).toContain("Current user request:");
          expect(text).toContain("hello");
        } else {
          expect(text).toContain("reprojected context");
        }
        await harness.completeTurn("completed", "thread-new");
        await run;
        if (!inactive && !transient) {
          const saved = await readCodexAppServerBinding(sessionFile);
          expect(saved?.threadId).toBe("thread-new");
          if (epoch) {
            expect(saved?.contextEngine?.projection?.epoch).toBe(epoch);
          } else {
            expect(saved?.contextEngine?.projection).toBeUndefined();
          }
        }
      } finally {
        releaseSandbox();
      }
    },
  );

  it("returns an exact terminal anchor for Cron turns without finalizing inside Codex", async () => {
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
    const harness = createStartedThreadHarness();
    const params = await createSqliteParams(workspaceDir, "cron");
    params.contextEngine = contextEngine;
    params.trigger = "cron";
    params.bootstrapContextRunKind = "cron";

    const finish = await startAttempt(params, harness);
    const result = await finish();

    expect(result.contextEngineTerminalAnchor).toMatchObject({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    expect(afterTurn).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
  });

  it("persists the admitted user prompt before an async item buffered during turn startup", async () => {
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

    const messages = await readTranscriptMessagesByIdentity(params);
    expect(messages.slice(0, 2).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]).toMatchObject({ openclawAsyncDelivery: { itemId: "startup-async" } });
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const manager = sessionManager();
    manager.appendMessage(assistantMessage("first baseline message", 1) as never);
    manager.appendMessage(userMessage("second baseline message", 2) as never);
    let preassemblyMessages: AgentMessage[] = [];
    let promptHookMessages: AgentMessage[] = [];
    promptHook(async (event) => {
      promptHookMessages = (event as { messages: AgentMessage[] }).messages;
      return {};
    });
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
    const { harness, params } = attempt({ contextEngine });

    const finish = await startAttempt(params, harness);
    await finish();

    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    const details = requireRecord(warning?.[1], "assemble warning details");
    expect(typeof details.error).toBe("string");
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String(details.error)).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(promptHookMessages).toEqual(preassemblyMessages);
    expect(promptHookMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(getRequestInputText(harness)).toContain(params.prompt);
  });
});
