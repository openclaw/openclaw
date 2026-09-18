import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
// Codex tests cover run attempt.context engine plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  createParams as createSharedParams,
  createStartedThreadHarness as createSharedStartedThreadHarness,
  runCodexAppServerAttempt as runSharedCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import { createContextEngine } from "./run-attempt.context-engine.test-support.js";

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  const params = createSharedParams(sessionFile, workspaceDir);
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

/** Keeps native Codex bindings reusable while omitting OpenClaw tools and search. */
function withPersistentCodexTestToolPolicy(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
  const modelCompat =
    params.model.compat && typeof params.model.compat === "object" ? params.model.compat : {};
  const model = {
    ...params.model,
    compat: { ...modelCompat, supportsTools: false },
  } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } };
  return {
    ...params,
    disableTools: false,
    model,
    config: {
      ...params.config,
      tools: {
        ...params.config?.tools,
        web: {
          ...params.config?.tools?.web,
          search: {
            ...params.config?.tools?.web?.search,
            enabled: false,
          },
        },
      },
    },
  };
}

function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: Parameters<typeof runSharedCodexAppServerAttempt>[1] = {},
) {
  return runSharedCodexAppServerAttempt(withPersistentCodexTestToolPolicy(params), options);
}

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

function createStartedThreadHarness(
  requestImpl?: Parameters<typeof createSharedStartedThreadHarness>[0],
  options?: Parameters<typeof createSharedStartedThreadHarness>[1],
) {
  const harness = createSharedStartedThreadHarness(requestImpl, options);
  return {
    ...harness,
    async completeTurn(status: "completed" | "failed" = "completed", threadId = "thread-1") {
      await harness.notify({
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

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
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
      return item.type === "text" ? (readStringValue(item.text) ?? "") : "";
    })
    .join("\n");
}

setupRunAttemptTestHooks();
describe("runCodexAppServerAttempt context-engine anchors", () => {
  it("keeps current inbound context at the front of the Codex context-engine prompt", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    openFileBackedSessionManagerForTest(sessionFile, { sessionId: "session-1" }).appendMessage(
      assistantMessage("older context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.currentInboundContext = {
      text: [
        "Conversation context (chronological, selected for current message):",
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
    expect(inputText.trim().startsWith("Conversation context (chronological")).toBe(true);

    await harness.completeTurn();
    await run;
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

  it("returns the terminal anchor needed by the outer fallback owner", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
    const harness = createStartedThreadHarness();
    const params = await createSqliteParams(workspaceDir, "deferred-after-turn");
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    const result = await run;

    expect(afterTurn).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    expect(result.contextEngineTerminalAnchor).toMatchObject({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
  });
});

describe("runCodexAppServerAttempt context-engine prompt persistence", () => {
  it("persists the admitted user prompt before an async item buffered during turn startup", async () => {
    const workspaceDir = path.join(tempDir, "workspace-early-async");
    const params = await createSqliteParams(workspaceDir, "early-async-order");
    params.onBlockReply = vi.fn();
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("expected user turn transcript recorder");
    }
    recorder.markRuntimePersistencePending = vi.fn();
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
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
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
});
