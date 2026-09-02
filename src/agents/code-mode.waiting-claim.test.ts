import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "../plugin-sdk/hook-runtime.js";
import { createMockPluginRegistry } from "../plugin-sdk/plugin-test-runtime.js";
import { disposeAllCodeModeRuns } from "./code-mode-state.js";
import { CodeModeTranscriptAuthority } from "./code-mode-waiting-claim.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { createToolSearchCatalogRef } from "./tool-search.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function appendControlResult(
  manager: SessionManager,
  toolCallId: string,
  toolName: "exec" | "wait",
  result: { content: AgentMessage["content"]; details?: unknown },
): void {
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AgentMessage);
  manager.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName,
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage);
}

describe("Code Mode durable waiting claims", () => {
  afterEach(() => {
    disposeAllCodeModeRuns();
    resetGlobalHookRunner();
    closeOpenClawAgentDatabasesForTest();
  });

  it("persists the embedded exec predecessor before wait and removes it on completion", async () => {
    const storePath = path.join(tempDirs.make("code-mode-waiting-"), "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "session-code-mode-waiting",
      sessionKey: "agent:main:code-mode-waiting",
      storePath,
    };
    const runId = "run-code-mode-waiting";
    replaceSessionEntrySync(target, {
      activeWriterRunId: runId,
      lifecycleRevision: "lifecycle-code-mode-waiting",
      sessionId: target.sessionId,
      updatedAt: Date.now(),
    });
    const config = {
      session: { store: storePath },
      tools: { codeMode: { enabled: true, timeoutMs: 2_000 } },
    } as never;
    const catalogRef = createToolSearchCatalogRef();
    const transcriptAuthority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "lifecycle-code-mode-waiting",
      writerRunId: runId,
    });
    const context = {
      ...target,
      sessionKey: "agent:main:sandbox-key-is-not-transcript-key",
      config,
      runtimeConfig: config,
      runId,
      catalogRef,
      transcriptAuthority,
    };
    const tools = createCodeModeTools(context);
    applyCodeModeCatalog({ ...context, tools });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: ({ message }: { message: AgentMessage }) =>
            message.role === "toolResult"
              ? {
                  message: {
                    ...message,
                    content: [{ type: "text", text: "replacement hook kept authority fields" }],
                  },
                }
              : undefined,
        },
      ]),
    );
    const manager = guardSessionManager(SessionManager.open(target), {
      agentId: target.agentId,
      runId,
      sessionKey: target.sessionKey,
      codeModeTranscriptAuthority: transcriptAuthority,
    });

    const execResult = await tools[0]!.execute("exec-call", {
      code: 'await yield_control("pause"); return "done";',
    });
    expect(execResult.details).toMatchObject({ status: "waiting" });
    appendControlResult(manager, "exec-call", "exec", execResult as never);

    const waitingRunId = (execResult.details as { runId: string }).runId;
    let entry = loadSessionEntryReadOnly(target) as InternalSessionEntry;
    expect(entry.codeModeWaitingClaims?.[waitingRunId]?.anchor).toMatchObject({
      idempotencyKey: "code-mode-result:exec-call",
    });
    expect(() =>
      transcriptAuthority.capture({
        outcome: "replace",
        runId: waitingRunId,
        sourceToolCallId: "exec-call",
        sourceToolName: "exec",
      }),
    ).toThrow("call id was reused");

    closeOpenClawAgentDatabasesForTest();
    const reopenedManager = guardSessionManager(SessionManager.open(target), {
      agentId: target.agentId,
      runId,
      sessionKey: target.sessionKey,
      codeModeTranscriptAuthority: transcriptAuthority,
    });
    const waitResult = await tools[1]!.execute("wait-call", { runId: waitingRunId });
    expect(waitResult.details).toMatchObject({ status: "completed", value: "done" });
    appendControlResult(reopenedManager, "wait-call", "wait", waitResult as never);

    entry = loadSessionEntryReadOnly(target) as InternalSessionEntry;
    expect(entry.codeModeWaitingClaims?.[waitingRunId]).toBeUndefined();
  });

  it("keeps reservations across content hooks and rejects identity replacement or theft", async () => {
    const storePath = path.join(tempDirs.make("code-mode-hook-identity-"), "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "session-code-mode-hook-identity",
      sessionKey: "agent:main:code-mode-hook-identity",
      storePath,
    };
    const runId = "run-code-mode-hook-identity";
    replaceSessionEntrySync(target, {
      activeWriterRunId: runId,
      lifecycleRevision: "lifecycle-code-mode-hook-identity",
      sessionId: target.sessionId,
      updatedAt: Date.now(),
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "lifecycle-code-mode-hook-identity",
      writerRunId: runId,
    });
    const config = { tools: { codeMode: { enabled: true, timeoutMs: 2_000 } } } as never;
    const catalogRef = createToolSearchCatalogRef();
    const context = {
      ...target,
      config,
      runtimeConfig: config,
      catalogRef,
      runId,
      transcriptAuthority: authority,
    };
    const tools = createCodeModeTools(context);
    applyCodeModeCatalog({ ...context, tools });
    let hookMode: "block" | "call" | "content" | "role" | "tool" = "call";
    let otherCallId = "exec-b";
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: ({ message }: { message: AgentMessage }) => {
            if (message.role !== "toolResult") {
              return undefined;
            }
            if (hookMode === "block") {
              return { block: true };
            }
            if (hookMode === "role") {
              return { message: { role: "assistant", content: [] } as AgentMessage };
            }
            return {
              message: {
                ...message,
                ...(hookMode === "call" ? { toolCallId: otherCallId } : {}),
                ...(hookMode === "tool" ? { toolName: "wait" } : {}),
                ...(hookMode === "content"
                  ? { content: [{ type: "text", text: "content-only replacement" }] }
                  : {}),
              },
            };
          },
        },
      ]),
    );
    const manager = guardSessionManager(SessionManager.open(target), {
      agentId: target.agentId,
      codeModeTranscriptAuthority: authority,
      runId,
      sessionKey: target.sessionKey,
    });
    const first = await tools[0]!.execute("exec-a", {
      code: 'await yield_control("pause-a"); return "a";',
    });
    const second = await tools[0]!.execute("exec-b", {
      code: 'await yield_control("pause-b"); return "b";',
    });
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "exec-a", name: "exec", arguments: {} },
        { type: "toolCall", id: "exec-b", name: "exec", arguments: {} },
      ],
      stopReason: "toolUse",
    } as AgentMessage);
    const source = {
      role: "toolResult",
      toolCallId: "exec-a",
      toolName: "exec",
      content: first.content,
      details: first.details,
      isError: false,
    } as AgentMessage;

    expect(() => manager.appendMessage(source)).toThrow("reservation identity changed");
    expect(authority.reserve(source)).toBeDefined();
    expect(
      authority.reserve({ ...source, toolCallId: "exec-b", details: second.details }),
    ).toBeDefined();

    for (const mode of ["tool", "role"] as const) {
      hookMode = mode;
      expect(() => manager.appendMessage(source)).toThrow("reservation identity changed");
      expect(authority.reserve(source)).toBeDefined();
    }
    hookMode = "block";
    expect(manager.appendMessage(source)).toBeUndefined();
    expect(authority.reserve(source)).toBeDefined();

    otherCallId = "unrelated";
    hookMode = "content";
    manager.appendMessage(source);
    const waitingRunId = (first.details as { runId: string }).runId;
    expect(
      (loadSessionEntryReadOnly(target) as InternalSessionEntry).codeModeWaitingClaims?.[
        waitingRunId
      ]?.anchor.idempotencyKey,
    ).toBe("code-mode-result:exec-a");
    expect(authority.reserve(source)).toBeUndefined();
  });

  it("gates detached controls and retained controls after authority close", async () => {
    const detached = createCodeModeTools({
      config: {},
      executeTool: async () => ({ content: [], details: {} }),
    });
    await expect(detached[0]!.execute("detached-exec", { code: "return 1" })).rejects.toThrow(
      "attached durable transcript authority",
    );
    await expect(detached[1]!.execute("detached-wait", { runId: "missing" })).rejects.toThrow(
      "attached durable transcript authority",
    );

    const storePath = path.join(tempDirs.make("code-mode-closed-"), "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "closed-session",
      sessionKey: "agent:main:closed-session",
      storePath,
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer",
      lifecycleRevision: "revision",
      sessionId: target.sessionId,
      updatedAt: Date.now(),
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision",
      writerRunId: "writer",
    });
    const retained = createCodeModeTools({
      ...target,
      config: {},
      executeTool: async () => ({ content: [], details: {} }),
      transcriptAuthority: authority,
    });
    expect(() =>
      authority.capture({
        outcome: "replace",
        predecessor: {
          anchor: {
            activeMessagePosition: 0,
            agentId: target.agentId,
            effectiveParentId: null,
            entryId: "expired",
            generation: "generation",
            idempotencyKey: "expired",
            rawSeq: 0,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            storePath,
          },
          expiresAt: Date.now() - 1,
          lifecycleRevision: "revision",
          runId: "expired-run",
          sourceDigest: "expired-digest",
          sourceToolCallId: "expired-call",
          sourceToolName: "exec",
          writerRunId: "writer",
        },
        runId: "expired-run",
        sourceToolCallId: "expired-call",
        sourceToolName: "exec",
      }),
    ).toThrow("claim is expired");
    authority.close();
    await expect(retained[0]!.execute("closed-exec", { code: "return 1" })).rejects.toThrow(
      "authority is closed",
    );
    await expect(retained[1]!.execute("closed-wait", { runId: "missing" })).rejects.toThrow(
      "authority is closed",
    );
  });
});
