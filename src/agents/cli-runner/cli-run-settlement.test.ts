import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions.js";
import { wrapRunWithTestPreparedAdmission } from "../admitted-run-context.test-support.js";
import {
  acquireSessionMcpRuntime,
  peekSessionMcpRuntime,
} from "../agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "../agent-bundle-mcp-manager-cleanup.js";
import {
  createSessionMcpRuntimeManager,
  unopenedMcpConfig,
} from "../agent-bundle-mcp-manager.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "../agent-bundle-mcp-runtime-shared.js";
import { transformCliResultText } from "../cli-output-results.js";
import { isCliBindingFlushed, runCliAgent } from "../cli-runner.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "../cli-session.js";
import * as cliTranscript from "../command/attempt-execution.helpers.js";
import { resolveDiagnosticModelResponse } from "../diagnostic-model-response.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../embedded-agent-runner/result-fallback-classifier.js";
import {
  buildBlockedCliRunResult,
  buildCliDeliveredFailure,
  buildCliRunResult,
  settleCliPreparationError,
  settlePreparedCliRun,
} from "./cli-run-settlement.js";
import { prepareCliRunTerminalReply } from "./terminal-reply.js";

type RunResultParams = Parameters<typeof buildCliRunResult>[0];
function testRunResult(
  context: RunResultParams["context"],
  output: RunResultParams["output"],
  overrides: Partial<Omit<RunResultParams, "context" | "output">> = {},
) {
  return buildCliRunResult({
    context,
    output,
    preparedReply: overrides.preparedReply ?? prepareCliRunTerminalReply(context, output),
    usedHistoryPrompt: false,
    userTurnHandled: true,
    sessionBindingDisabled: true,
    preparedContextAgentMeta: {},
    ...overrides,
  });
}

function continuityResult(context: RunResultParams["context"], kind: string) {
  const common = { context, preparedContextAgentMeta: {}, sessionBindingDisabled: false };
  return kind === "blocked"
    ? buildBlockedCliRunResult({ ...common, message: "Blocked by the test policy" })
    : kind === "delivered-failure"
      ? buildCliDeliveredFailure({
          ...common,
          error: new Error("synthetic failure"),
          evidence: { didSendViaMessagingTool: true },
        })
      : testRunResult(
          context,
          { text: "done" },
          {
            effectiveCliSessionId: kind === "native" ? "next-native-session" : undefined,
            bindingFlushOk: kind !== "no-native-id",
            sessionBindingDisabled: kind === "stateless",
          },
        );
}

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => name === "before_agent_reply",
    runBeforeAgentReply: async () => ({ handled: true, reply: { text: "Hook reply" } }),
  }),
}));

describe("isCliBindingFlushed", () => {
  const workspaceDir = "/tmp/openclaw-workspace";
  const probe = vi.fn(async () => false);

  beforeEach(() => {
    vi.useRealTimers();
    probe.mockReset().mockResolvedValue(false);
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockImplementation(probe);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.mocked(cliTranscript.claudeCliSessionTranscriptHasContent).mockRestore();
  });

  it("returns false when no sessionId is provided", async () => {
    probe.mockResolvedValue(true);
    expect(await isCliBindingFlushed(undefined, "claude-cli")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("succeeds when the transcript becomes visible on a later retry", async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce(false).mockResolvedValue(true);

    const result = isCliBindingFlushed("sid-late", "claude-cli", workspaceDir);
    await vi.advanceTimersByTimeAsync(49);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules at most 0 + 50 + 150ms of delay across the bounded retry", async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const errored = vi.fn();
    isCliBindingFlushed("sid-bounded", "claude-cli", workspaceDir).then(settled, errored);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(150);
    expect(settled.mock.calls).toEqual([[false]]);
    expect(errored).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("returns true without probing for non-claude-cli providers", async () => {
    expect(await isCliBindingFlushed("sid-codex", "codex-cli")).toBe(true);
    expect(await isCliBindingFlushed("sid-anthropic", "anthropic")).toBe(true);
    expect(await isCliBindingFlushed("sid-openai", "openai")).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true without probing when the caller owns continuity outside native transcripts", async () => {
    expect(
      await isCliBindingFlushed("sid-warm", "claude-cli", workspaceDir, {
        skipTranscriptProbe: true,
      }),
    ).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});

it.each(["required", "result-required", "optional"] as const)(
  "preserves the %s reply obligation through classification",
  (terminalReplyExpectation) => {
    const context = buildPreparedCliRunContext({ provider: "claude-cli" });
    context.params.terminalReplyExpectation = terminalReplyExpectation;
    const result = testRunResult(
      context,
      { text: "" },
      {
        bindingFlushOk: true,
        sessionBindingDisabled: false,
      },
    );
    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "test-model",
      result,
    });
    expect(classification).toEqual(
      terminalReplyExpectation === "optional"
        ? null
        : expect.objectContaining({ reason: "format", code: "empty_result" }),
    );
  },
);
it.each(["blocked", "no-native-id", "native", "stateless"])(
  "projects only explicit native continuity from a %s result",
  (kind) => {
    const context = buildPreparedCliRunContext({ provider: "claude-cli" });
    context.params.modelProvider = "anthropic";
    const result = continuityResult(context, kind);
    const entry: SessionEntry = {
      sessionId: context.params.sessionId,
      updatedAt: 1,
      cliSessionBindings: { "claude-cli": { sessionId: "previous-native-session" } },
    };

    applyCliSessionBindingResult(entry, "claude-cli", result.meta.agentMeta);

    expect(entry.sessionId).toBe(context.params.sessionId);
    expect(result.meta.agentMeta?.sessionId).toBe(
      kind === "native" ? "next-native-session" : context.params.sessionId,
    );
    expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe(
      kind === "native"
        ? "next-native-session"
        : kind === "stateless"
          ? undefined
          : "previous-native-session",
    );
  },
);

it.each(
  ["anthropic", undefined].flatMap((modelProvider) =>
    ["completed", "blocked", "delivered-failure", "hook-handled"].map((kind) => ({
      modelProvider,
      kind,
    })),
  ),
)(
  "$kind preserves model provider=$modelProvider and backend identity",
  async ({ modelProvider, kind }) => {
    const context = buildPreparedCliRunContext({ provider: "claude-cli" });
    if (modelProvider !== undefined) {
      context.params.modelProvider = modelProvider;
    }
    const result =
      kind === "hook-handled"
        ? await wrapRunWithTestPreparedAdmission(runCliAgent)({
            sessionId: context.params.sessionId,
            sessionFile: context.params.sessionFile,
            sessionKey: context.params.sessionKey,
            workspaceDir: context.workspaceDir,
            prompt: "Hook-owned reply",
            provider: context.params.provider,
            ...(modelProvider !== undefined ? { modelProvider } : {}),
            model: context.modelId,
            timeoutMs: 30_000,
            runId: context.params.runId,
            trigger: "user",
          })
        : continuityResult(context, kind === "completed" ? "native" : kind);

    expect(result.meta.agentMeta?.provider).toBe(modelProvider ?? "claude-cli");
    if (kind === "hook-handled") {
      expect(result.meta.executionTrace).toBeUndefined();
    } else {
      expect(result.meta.executionTrace).toMatchObject({
        winnerProvider: "claude-cli",
        attempts: [expect.objectContaining({ provider: "claude-cli" })],
      });
    }
  },
);

it.each([false, true])("rejects undefined after cleanup failure=%s", async (cleanupFails) => {
  const context = buildPreparedCliRunContext();
  const cleanup = vi.fn(async () => {
    if (cleanupFails) {
      throw new Error("synthetic cleanup failure");
    }
  });
  context.params.cleanupCliLiveSessionOnRunEnd = true;
  context.preparedBackend.closeLiveSession = cleanup;

  await expect(
    settlePreparedCliRun({
      context,
      run: vi.fn().mockRejectedValue(undefined),
    }),
  ).rejects.toThrow(new Error("undefined"));
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(["progress", "ambiguous", "final"] as const)(
  "requires final source delivery to preserve a %s message through cleanup failure",
  async (delivery) => {
    const context = buildPreparedCliRunContext();
    const error = new Error("backend release failed");
    context.preparedBackend.cleanup = async () => {
      throw error;
    };
    const result = {
      payloads: [{ text: "output" }],
      meta: { durationMs: 1 },
      didSendViaMessagingTool: true,
      ...(delivery === "ambiguous"
        ? {}
        : {
            messagingToolSourceReplyPayloads: [
              { text: "output", sourceReplyFinal: delivery === "final" },
            ],
          }),
    };
    const settled = settlePreparedCliRun({ context, run: async () => result });
    if (delivery === "final") {
      await expect(settled).resolves.toBe(result);
    } else {
      await expect(settled).rejects.toBe(error);
    }
  },
);

it.each(["Done", ""])("captures only the final CLI result %j after narration", (rawFinalText) => {
  const textParts = rawFinalText ? ["Checking now", rawFinalText] : undefined;
  const text = textParts?.join("\n") ?? "Checking now";
  const output = transformCliResultText({ text, textParts, rawFinalText });
  const result = testRunResult(buildPreparedCliRunContext(), output);
  expect(result.meta.finalAssistantRawText).toBe(text);
  expect(resolveDiagnosticModelResponse(result)).toBe(rawFinalText || undefined);
});

it("never captures host-synthesized optional silence as model output", async () => {
  const context = buildPreparedCliRunContext();
  context.params.terminalReplyExpectation = "optional";
  const result = testRunResult(context, { text: "" });
  expect(result.payloads).toBeUndefined();
  expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
  expect(resolveDiagnosticModelResponse(result)).toBeUndefined();
});

it("preserves completed result boundaries for independent final delivery", async () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli" });
  const output = {
    text: "First answer.\nLast answer.",
    textParts: ["First answer.", "Last answer."],
  };
  const result = testRunResult(context, output, {
    assistantTranscriptOwned: true,
    assistantTranscriptIdempotencyKey: "synthetic-turn",
  });
  expect(result.payloads).toEqual([{ text: "First answer." }, { text: "Last answer." }]);
  const { getReplyPayloadMetadata } = await import("../../auto-reply/reply-payload.js");
  for (const [assistantMessageIndex, payload] of (result.payloads ?? []).entries()) {
    expect(getReplyPayloadMetadata(payload)).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "synthetic-turn",
      assistantMessageIndex,
    });
  }
});

describe("CLI MCP retirement", () => {
  let manager: ReturnType<typeof createSessionMcpRuntimeManager>;
  let previous: PropertyDescriptor | undefined;
  beforeEach(() => {
    manager = createSessionMcpRuntimeManager();
    previous = Object.getOwnPropertyDescriptor(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, {
      configurable: true,
      writable: true,
      value: manager,
    });
  });
  afterEach(async () => {
    await manager.disposeAll();
    if (previous) {
      Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, previous);
    } else {
      Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    }
  });
  const input = (sessionId: string) => ({
    sessionId,
    workspaceDir: "/workspace",
    cfg: unopenedMcpConfig,
    manifestRegistry: { plugins: [] },
  });

  it.each([false, true])("joins preparation cleanup with revoked authority %s", async (revoked) => {
    const runtime = await manager.getOrCreate(input("preparation"));
    const survivor = await manager.getOrCreate(input("survivor"));
    const started = createDeferred();
    const finish = createDeferred();
    const dispose = runtime.dispose.bind(runtime);
    let closing = false;
    vi.spyOn(runtime, "dispose").mockImplementationOnce(async () => {
      closing = true;
      started.resolve();
      await finish.promise;
      await dispose();
    });
    const context = buildPreparedCliRunContext({ sessionId: runtime.sessionId });
    const authorityError = new Error("Preparation authority revoked");
    let settled = false;
    const cleanup = settleCliPreparationError(new Error("Preparation failed"), {
      ...context.params,
      cleanupBundleMcpOnRunEnd: true,
      assertCurrent: () => {
        if (revoked) {
          throw authorityError;
        }
      },
    }).finally(() => {
      settled = true;
    });
    void cleanup.catch(() => undefined);
    try {
      await Promise.race([started.promise, cleanup.catch(() => undefined)]);
      expect(closing).toBe(true);
      expect(settled).toBe(false);
      finish.resolve();
      if (revoked) {
        await expect(cleanup).rejects.toBe(authorityError);
      } else {
        await expect(cleanup).resolves.toBeUndefined();
      }
      expect(peekSessionMcpRuntime({ sessionId: runtime.sessionId })).toBeUndefined();
      expect(peekSessionMcpRuntime({ sessionId: survivor.sessionId })).toBe(survivor);
    } finally {
      finish.resolve();
      await cleanup.catch(() => undefined);
    }
  });

  it("defers terminal retirement until the session's active lease releases", async () => {
    const acquired = await acquireSessionMcpRuntime(input("active"));
    const survivor = await manager.getOrCreate(input("survivor"));
    const context = buildPreparedCliRunContext({ sessionId: acquired.runtime.sessionId });
    context.params.cleanupBundleMcpOnRunEnd = true;
    const result = { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
    try {
      await expect(settlePreparedCliRun({ context, run: async () => result })).resolves.toBe(
        result,
      );
      expect(peekSessionMcpRuntime({ sessionId: acquired.runtime.sessionId })).toBe(
        acquired.runtime,
      );
      await releaseSessionMcpRuntime(acquired);
      expect(peekSessionMcpRuntime({ sessionId: acquired.runtime.sessionId })).toBeUndefined();
      expect(peekSessionMcpRuntime({ sessionId: survivor.sessionId })).toBe(survivor);
    } finally {
      await releaseSessionMcpRuntime(acquired);
    }
  });
});
