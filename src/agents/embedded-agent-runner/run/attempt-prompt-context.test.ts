import { QUEUED_USER_MESSAGE_MARKER } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { addSession, appendOutput, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import * as mediaTaskStatus from "../../media-generation-task-status.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { resetSubagentRegistryForTests } from "../../subagents/registry/subagent-registry.test-helpers.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  info: vi.fn(),
  reconcileToolResultPromptProjectionState: vi.fn(),
  resolveLiveToolResultAggregateMaxChars: vi.fn(() => 200),
  resolveLiveToolResultMaxChars: vi.fn(() => 100),
  truncateOversizedToolResultsInMessages: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { info: hoisted.info, warn: hoisted.warn },
}));
// mock-isolation: Control projection decisions without the runtime truncation state.
vi.mock("../tool-result-truncation.js", () => ({
  resolveLiveToolResultAggregateMaxChars: hoisted.resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars: hoisted.resolveLiveToolResultMaxChars,
  reconcileToolResultPromptProjectionState: hoisted.reconcileToolResultPromptProjectionState,
  truncateOversizedToolResultsInMessages: hoisted.truncateOversizedToolResultsInMessages,
}));

import { resolveAgentProfile } from "../../agent-profiles.js";
import { resolveContextSerialization } from "../../context-serialization/resolve.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { prepareEmbeddedAttemptPromptContext as prepareContext } from "./attempt-prompt-build.js";
import { buildSystemUpdateMessage } from "./runtime-context-prompt.js";

const temporalContext = "## Temporal Context\nCurrent date: 2026-10-09\nTime zone: UTC";
const inboundRuntimeContext = `Conversation info: channel=telegram\n\n${temporalContext}`;

const messages = [
  {
    role: "user",
    content: [{ type: "text", text: "Previous request" }],
    timestamp: 100,
  },
] as AgentMessage[];

const projectionState: ToolResultPromptProjectionState = {
  replacements: new Map(),
  frozen: new Set(),
  ambiguousBaseKeys: new Set(),
  restoredCacheTtl: new Map(),
  sourceHashByKey: new Map(),
};

function createAttempt(overrides?: Partial<EmbeddedRunAttemptParams>) {
  return {
    config: { agents: { defaults: { userTimezone: "UTC" } } },
    contextTokenBudget: 32_000,
    currentInboundContext: {
      text: "Conversation info: channel=telegram",
    },
    currentInboundEventKind: "user_request",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    suppressNextUserMessagePersistence: false,
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

type PromptInput = Parameters<typeof prepareContext>[0]["prompt"];

function createPrompt(overrides?: Partial<PromptInput>): PromptInput {
  return {
    effectivePrompt: "Visible request",
    effectiveTranscriptPrompt: "Visible request",
    ...overrides,
  };
}

function createInput(options?: {
  attempt?: EmbeddedRunAttemptParams;
  messages?: AgentMessage[];
  preparedUserTurnMessage?: AgentMessage;
  prompt?: ReturnType<typeof createPrompt>;
  report?: SessionSystemPromptReport;
}) {
  const replaceSessionMessages = vi.fn();
  const report = options?.report ?? ({} as SessionSystemPromptReport);
  const attempt = options?.attempt ?? createAttempt({ trigger: "user" });
  setRuntimeConfigSnapshot(attempt.config ?? {});
  return {
    input: {
      attempt,
      capabilityToolNames: new Set<string>(),
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      messages: options?.messages ?? messages,
      preparedUserTurnMessage:
        options?.preparedUserTurnMessage ??
        ({ role: "user", content: "Visible request", timestamp: 123 } as AgentMessage),
      prompt: options?.prompt ?? createPrompt(),
      replaceSessionMessages,
      sessionAgentId: "agent-1",
      systemPromptReport: report,
      systemPromptText: "Base system prompt",
      toolResultPromptProjectionState: projectionState,
    },
    replaceSessionMessages,
    report,
  };
}

beforeEach(async () => {
  setRuntimeConfigSnapshot({ agents: { defaults: { userTimezone: "UTC" } } });
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T12:00:00Z"));
  vi.spyOn(mediaTaskStatus, "buildMediaTaskRuntimeContext").mockResolvedValue(undefined);
  await resetSubagentRegistryForTests({ persist: false });
  hoisted.reconcileToolResultPromptProjectionState.mockReset();
  hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
    messages: inputMessages,
    truncatedCount: 0,
    aggregateTruncatedCount: 0,
    aggregatePressureEngaged: false,
    aggregateBudgetChars: 200,
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  deleteSession("exec-a");
  deleteSession("exec-z");
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
});

describe("prepareEmbeddedAttemptPromptContext", () => {
  registerParityHostLifecycle();

  it("reports unavailable MCP servers in this turn without rewriting history or the system prompt", async () => {
    const fixture = createInput();
    const history = JSON.stringify(fixture.input.messages);
    const prepared = await prepareContext({
      ...fixture.input,
      sessionVersion: 4,
      appendOnlyRuntimeContext: true,
      mcpDiagnostics: [
        {
          serverName: "fixture",
          safeServerName: "fixture",
          launchSummary: "synthetic server",
          message: "MCP tool listing timed out after 10000ms",
        },
      ],
    });
    expect(prepared.runtimeContextMessageForCurrentTurn?.content).toContain(
      "MCP server fixture unavailable: MCP tool listing timed out after 10000ms",
    );
    expect(prepared.runtimeContextMessageForCurrentTurn?.content).toContain(
      "Check server reachability",
    );
    expect(JSON.stringify(fixture.input.messages)).toBe(history);
    expect(fixture.input.systemPromptText).toBe("Base system prompt");
  });

  it("preserves fallback context envelopes and canonical input across route switches and replay", async () => {
    const original = "Describe the attached landscape.";
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: original, idempotencyKey: "fallback-envelope:user", timestamp: 123 },
      target: () => undefined,
    });
    recorder.markSentToProvider?.();
    const canonicalUser: AgentMessage = {
      ...recorder.message!,
      content: [
        { type: "text", text: original },
        { type: "image", data: "aW1n", mimeType: "image/png" },
      ],
    };
    const initialContext = buildSystemUpdateMessage(
      "Original runtime facts",
      "runtime-context",
      true,
    );
    const fixture = createInput({
      attempt: createAttempt({ userTurnTranscriptRecorder: recorder, fallbackActive: true }),
      preparedUserTurnMessage: canonicalUser,
      messages: [canonicalUser, initialContext],
      prompt: createPrompt({
        effectivePrompt: original,
        effectiveTranscriptPrompt: original,
        promptBuildAppendContext: "Use the fallback route's current instructions.",
      }),
    });
    const prepared = await prepareContext({
      ...fixture.input,
      sessionVersion: 4,
      appendOnlyRuntimeContext: true,
      inHistorySystemUpdates: false,
    });
    const fallback = prepared.runtimeContextMessageForCurrentTurn!;
    expect(prepared.isDispatchedCanonicalFallback).toBe(true);
    expect(fallback.details).toMatchObject({ replay: "append" });
    const source = [...fixture.input.messages, fallback];
    const before = JSON.stringify(source);
    const capture = async (native: boolean, history = source) => {
      const { payload } = await captureAnthropicRequest("provider", {
        model: {
          id: "claude-opus-5",
          baseUrl: native ? "https://api.anthropic.com" : "https://proxy.example/v1",
          input: ["text", "image"],
        },
        cacheRetention: "none",
        context: {
          systemPrompt: "Stable system prompt",
          messages: convertToLlm(
            normalizeMessagesForLlmBoundary(history, {
              sessionVersion: 4,
              appendOnlyRuntimeContext: true,
              inHistorySystemUpdates: native,
              includeTimestamp: false,
            }),
          ),
        },
      });
      if (!Array.isArray(payload.messages)) {
        throw new Error("Expected serialized provider messages");
      }
      expect(
        JSON.stringify(payload.messages).match(/Describe the attached landscape\./g),
      ).toHaveLength(1);
      expect(JSON.stringify(payload.messages).match(/"type":"image"/g)).toHaveLength(1);
      return payload.messages;
    };
    const native = await capture(true);
    expect(native.at(-1)).toEqual({
      role: "system",
      content: [{ type: "text", text: fallback.content }],
      clear_at: "next_user_message",
    });
    const proxy = await capture(false);
    expect(proxy.at(-1)).toEqual({
      role: "user",
      content: `OpenClaw runtime context:\n${fallback.content}\nEnd OpenClaw runtime context.`,
    });
    expect(await capture(true)).toEqual(native);
    const replay = await capture(false, [
      ...source,
      makeAgentAssistantMessage({ content: [{ type: "text", text: "Done." }] }),
      { role: "user", content: "Next question", timestamp: 124 },
    ]);
    expect(replay.slice(0, proxy.length)).toEqual(proxy);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("preserves attempt then system fragment bytes without changing either source", async () => {
    const attemptFragments = [{ kind: "runtime-instruction" as const, text: "Turn instruction" }];
    const systemFragments = [{ kind: "conversation-data" as const, text: "System context" }];
    Object.freeze(attemptFragments);
    Object.freeze(systemFragments);
    const fixture = createInput({
      attempt: createAttempt({
        currentInboundContext: undefined,
        runtimeContextFragments: attemptFragments,
      }),
    });

    const result = await prepareContext({
      ...fixture.input,
      isRawModelRun: true,
      systemPromptRuntimeContextFragments: systemFragments,
    });

    expect(result.runtimeContextFragments).toEqual([
      { kind: "runtime-instruction", text: "Turn instruction" },
      { kind: "conversation-data", text: "System context" },
    ]);
    expect(result.runtimeContextMessageForCurrentTurn?.content).toBe(
      "Turn instruction\n\nSystem context",
    );
    expect(result.systemPromptForHook).toBe("Base system prompt");
    expect(result.promptForModel).toBe("Visible request");
    expect(attemptFragments).toEqual([{ kind: "runtime-instruction", text: "Turn instruction" }]);
    expect(systemFragments).toEqual([{ kind: "conversation-data", text: "System context" }]);
  });

  it.each(
    [3, 4].flatMap((sessionVersion) =>
      ["dispatched", "pending", "internal", "raw"].map((state) => ({ sessionVersion, state })),
    ),
  )(
    "separates fallback hooks from the canonical user only after dispatch (v$sessionVersion, $state)",
    async ({ sessionVersion, state }) => {
      const original = "Describe the attached landscape.";
      const prepend = "Use the backup provider's visual guidance.";
      const append = "Explain the visible colors.";
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: original, idempotencyKey: "fallback-context:user", timestamp: 123 },
        target: () => undefined,
      });
      if (state !== "pending") {
        recorder.markSentToProvider?.();
      }
      const fixture = createInput({
        attempt: createAttempt({
          userTurnTranscriptRecorder: recorder,
          skipPreparedUserTurnMessage: state === "internal",
          fallbackActive: true,
        }),
        preparedUserTurnMessage: recorder.message,
        messages: recorder.message ? [recorder.message] : [],
        prompt: createPrompt({
          effectivePrompt: [prepend, original, append].join("\n\n"),
          effectiveTranscriptPrompt: original,
          promptBuildPrependContext: prepend,
          promptBuildAppendContext: append,
        }),
      });

      const result = await prepareContext({
        ...fixture.input,
        sessionVersion,
        appendOnlyRuntimeContext: sessionVersion === 4,
        inHistorySystemUpdates: sessionVersion === 4,
        isRawModelRun: state === "raw",
      });

      const dispatchedFallback = state === "dispatched";
      expect(result.isDispatchedCanonicalFallback).toBe(dispatchedFallback);
      expect(result.promptForSession).toBe(original);
      expect(result.llmBoundaryPromptForPrecheck).toBe(
        dispatchedFallback ? original : [prepend, original, append].join("\n\n"),
      );
      const carrier = result.runtimeContextMessageForCurrentTurn;
      expect(carrier?.content).not.toContain(original);
      if (dispatchedFallback) {
        expect(carrier?.details).toMatchObject({
          kind: "runtime-context",
          turnScoped: true,
          replay: "append",
        });
        expect(carrier?.content.match(/Use the backup provider's visual guidance\./g)).toHaveLength(
          1,
        );
        expect(carrier?.content.match(/Explain the visible colors\./g)).toHaveLength(1);
        expect(JSON.stringify(result.hookMessagesForCurrentPrompt)).toContain(prepend);
      } else {
        expect(carrier?.content).not.toContain(prepend);
        expect(carrier?.content).not.toContain(append);
        expect(carrier?.details).not.toHaveProperty("replay");
      }
      if (state !== "raw") {
        expect(carrier?.content).toContain("## Temporal Context");
      }
    },
  );

  it("carries execution-owned processes in id order without elapsed time or output", async () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames.add("process");
    const idle = await prepareContext(fixture.input);
    expect(idle.runtimeContextMessageForCurrentTurn?.content ?? "").not.toContain(
      "Active exec sessions at turn start (snapshot):",
    );
    for (const id of ["exec-z", "exec-a"]) {
      const session = createProcessSessionFixture({ id, backgrounded: true });
      session.scopeKey = fixture.input.attempt.sessionKey;
      appendOutput(session, "stdout", "private output tail");
      addSession(session);
    }
    const active = await prepareContext(fixture.input);
    expect(active.systemPromptForHook).toBe(idle.systemPromptForHook);
    const content = active.runtimeContextMessageForCurrentTurn?.content;
    expect(content).toContain("Active exec sessions at turn start (snapshot):");
    expect(content).toContain("exec-a running");
    expect(content!.indexOf("exec-a")).toBeLessThan(content!.indexOf("exec-z"));
    expect(content).not.toMatch(/private output tail|runtimeMs|startedAt/);
    expect(active.runtimeContextMessageForCurrentTurn?.details.fragments).toContainEqual({
      kind: "conversation-data",
      text: expect.stringContaining("Active exec sessions at turn start (snapshot):"),
    });
    expect(active.promptForSession).toBe("Visible request");
    deleteSession("exec-a");
    const nextTurn = await prepareContext({
      ...fixture.input,
      appendOnlyRuntimeContext: true,
      messages: [...messages, active.runtimeContextMessageForCurrentTurn!],
    });
    expect(nextTurn.runtimeContextMessageForCurrentTurn?.content).not.toContain("exec-a running");
    expect(nextTurn.hookMessagesForCurrentPrompt).toContainEqual(
      expect.objectContaining({ role: "custom", content }),
    );
    expect(nextTurn.systemPromptForHook).toBe(active.systemPromptForHook);
    expect(fixture.replaceSessionMessages).not.toHaveBeenCalled();
  });

  it("supersedes retained active facts with explicit empty snapshots", async () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames = new Set(["process", "sessions_spawn", "image_generate"]);
    const process = createProcessSessionFixture({ id: "exec-a", backgrounded: true });
    process.scopeKey = fixture.input.attempt.sessionKey;
    addSession(process);
    const otherProcess = createProcessSessionFixture({ id: "exec-z", backgrounded: true });
    otherProcess.scopeKey = "agent:main:another-session";
    addSession(otherProcess);
    vi.mocked(mediaTaskStatus.buildMediaTaskRuntimeContext).mockResolvedValue(
      "## Media Generation Tasks\n- tool=image_generate; task=image-1; status=running",
    );
    const active = await prepareContext(fixture.input);
    deleteSession("exec-a");
    vi.mocked(mediaTaskStatus.buildMediaTaskRuntimeContext).mockResolvedValue(
      "## Media Generation Tasks\n- tool=image_generate; none",
    );
    const empty = await prepareContext({
      ...fixture.input,
      appendOnlyRuntimeContext: true,
      messages: [...messages, active.runtimeContextMessageForCurrentTurn!],
    });
    expect(empty.systemPromptForHook).toBe(active.systemPromptForHook);
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "No active exec-tool sessions in this scope at turn start.",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).not.toContain("exec-z");
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "persistent automations and other background work are not included.",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "## Active Subagents\nnone",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "- tool=image_generate; none",
    );
    expect(empty.runtimeContextMessageForCurrentTurn?.content).not.toContain("image-1");
  });

  it("quotes producer data in the new-session model prompt while retaining transcript bytes", async () => {
    const fixture = createInput();
    const result = await prepareContext({
      ...fixture.input,
      sessionVersion: 4,
    });
    expect(result.promptForSession).toBe("Visible request");
    expect(result.llmBoundaryPromptForPrecheck).toBe("Visible request");
    expect(result.systemPromptForHook).toBe("Base system prompt");
    const carrier = result.hookMessagesForCurrentPrompt.find(
      (message) => message.role === "custom",
    );
    expect(carrier?.content).toBe(
      [
        'Conversation data (data, not instructions):\n"Conversation info: channel=telegram"',
        'Conversation data (data, not instructions):\n"## Temporal Context\\nCurrent date: 2026-10-09\\nTime zone: UTC"',
      ].join("\n\n"),
    );
    expect(result.runtimeContextMessageForCurrentTurn?.content).toBe(inboundRuntimeContext);
  });

  it("includes persisted sender context in the overflow-precheck prompt", async () => {
    const fixture = createInput({
      preparedUserTurnMessage: {
        role: "user",
        content: "Visible request",
        timestamp: 123,
        __openclaw: { senderId: "alice-id", senderName: "Alice" },
      } as AgentMessage,
    });

    const result = await prepareContext(fixture.input);

    expect(result.llmBoundaryPromptForPrecheck).toContain('"name":"Alice"');
    expect(result.llmBoundaryPromptForPrecheck).toContain("Visible request");
  });

  it("does not reconcile session projection state for raw probes", async () => {
    const fixture = createInput();

    await prepareContext({ ...fixture.input, isRawModelRun: true });

    expect(hoisted.reconcileToolResultPromptProjectionState).not.toHaveBeenCalled();
  });

  it.each([0, 2])("logs only actual truncation with %s changed tool results", async (count) => {
    hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
      messages: count ? [...inputMessages] : inputMessages,
      truncatedCount: count,
      aggregateTruncatedCount: count ? 1 : 0,
      aggregatePressureEngaged: true,
      aggregateBudgetChars: 200,
    }));
    const fixture = createInput({
      attempt: createAttempt({ sessionId: "pressure-session", sessionKey: "pressure-session" }),
    });

    const result = await prepareContext(fixture.input);

    expect(result.aggregatePressureEngaged).toBe(true);
    expect(hoisted.warn).not.toHaveBeenCalled();
    expect(hoisted.info).toHaveBeenCalledTimes(count ? 1 : 0);
    if (count) {
      expect(hoisted.info).toHaveBeenCalledWith(
        expect.stringContaining("Truncated 2 tool result(s)"),
      );
    }
  });

  it.each([4])(
    "carries version %s runtime-only events in the message tail carrier without rewriting system prompt",
    async (sessionVersion) => {
      const fixture = createInput({
        attempt: createAttempt({
          currentInboundContext: {
            text: "Room conversation data",
          },
          runtimeContextFragments: [{ kind: "runtime-instruction", text: "Runtime room event" }],
          currentInboundEventKind: "room_event",
        }),
        prompt: createPrompt({
          effectivePrompt: "",
          effectiveTranscriptPrompt: "",
        }),
      });

      fixture.input.capabilityToolNames.add("process");
      const result = await prepareContext({
        ...fixture.input,
        sessionVersion,
      });

      expect(result.systemPromptForHook).toBe("Base system prompt");
      expect(result.promptSubmission.runtimeOnly).toBe(true);
      expect(result.promptForSession).toBe("Continue the OpenClaw runtime event.");
      expect(result.promptForModel).toBe(result.promptForSession);
      expect(result.runtimeContextMessageForCurrentTurn?.content ?? "").not.toContain(
        "Active exec sessions at turn start (snapshot):",
      );
      expect(result.runtimeContextMessageForCurrentTurn?.content).toContain("Runtime room event");
      expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(
        "Room conversation data",
      );
      expect(fixture.report.currentTurn?.kind).toBe("room_event");
      expect(fixture.report.currentTurn?.runtimeContextChars).toBeGreaterThan(0);
    },
  );

  describe("compact context serialization", () => {
    const compactSerialization = { mode: "compact", source: "agent-profile" } as const;
    const verboseInbound = "Conversation info: verbose block with every channel field";
    const compactInbound = "Compact conversation info";

    it("carries the compact inbound text instead of the default text on a normal turn", async () => {
      const fixture = createInput({
        attempt: createAttempt({
          currentInboundContext: { text: verboseInbound, compactText: compactInbound },
        }),
      });

      const result = await prepareContext({
        ...fixture.input,
        contextSerialization: compactSerialization,
      });

      const carrier = result.runtimeContextMessageForCurrentTurn?.content ?? "";
      expect(carrier).toContain(compactInbound);
      expect(carrier).not.toContain(verboseInbound);
      expect(carrier).not.toContain("OpenClaw runtime facts");
      expect(carrier).not.toContain("[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]");
    });

    it("carries the compact inbound text once, in the carrier, on a runtime-only turn", async () => {
      const fixture = createInput({
        attempt: createAttempt({
          currentInboundContext: { text: verboseInbound, compactText: compactInbound },
          runtimeContextFragments: [{ kind: "runtime-instruction", text: "Runtime room event" }],
          currentInboundEventKind: "room_event",
        }),
        prompt: createPrompt({ effectivePrompt: "", effectiveTranscriptPrompt: "" }),
      });

      const result = await prepareContext({
        ...fixture.input,
        contextSerialization: compactSerialization,
        sessionVersion: 4,
      });

      const carrier = result.runtimeContextMessageForCurrentTurn?.content ?? "";
      expect(result.promptForModel).not.toContain(compactInbound);
      expect(carrier).toContain("Runtime room event");
      expect(carrier).toContain(compactInbound);
      expect(carrier.split(compactInbound)).toHaveLength(2);
      expect(carrier).not.toContain(verboseInbound);
    });

    it.each([
      { agentProfileId: undefined, mode: "default" },
      { agentProfileId: "openclaw/base", mode: "default" },
      { agentProfileId: "openclaw/small", mode: "compact" },
      { agentProfileId: "auto", mode: "compact" },
    ] as const)(
      "sends the $mode inbound block for agentProfileId $agentProfileId on a small model",
      async ({ agentProfileId, mode }) => {
        const config = {
          agents: {
            defaults: { userTimezone: "UTC", ...(agentProfileId ? { agentProfileId } : {}) },
          },
        };
        const contextSerialization = resolveContextSerialization({
          resolvedProfile: resolveAgentProfile({
            config,
            agentId: "main",
            modelSizeClass: "small",
          }),
        });
        const fixture = createInput({
          attempt: createAttempt({
            config,
            currentInboundContext: {
              text: verboseInbound,
              compactText: compactInbound,
              serializationStats: { removedSessionMessages: 2, deduplicatedMessages: 1 },
            },
          }),
        });

        const result = await prepareContext({ ...fixture.input, contextSerialization });

        const carrier = result.runtimeContextMessageForCurrentTurn?.content ?? "";
        expect(contextSerialization.mode).toBe(mode);
        expect(carrier).toContain(mode === "compact" ? compactInbound : verboseInbound);
        expect(carrier).not.toContain(mode === "compact" ? verboseInbound : compactInbound);
        expect(fixture.report.contextSerialization).toMatchObject({
          mode,
          removedSessionMessages: mode === "compact" ? 2 : 0,
          deduplicatedMessages: mode === "compact" ? 1 : 0,
        });
      },
    );

    it("keeps the delivery directive an instruction in the compact carrier of a v4 session", async () => {
      const directive =
        "To respond visibly, use message(action=send); your final text stays private.";
      const fixture = createInput({
        attempt: createAttempt({
          currentInboundContext: {
            text: verboseInbound,
            compactText: `${compactInbound}\n\n${directive}`,
            compactFragments: [
              { kind: "conversation-data", text: compactInbound },
              { kind: "runtime-instruction", text: directive },
            ],
          },
        }),
      });

      const result = await prepareContext({
        ...fixture.input,
        contextSerialization: compactSerialization,
        sessionVersion: 4,
      });

      const details = result.runtimeContextMessageForCurrentTurn?.details as
        | { fragments?: Array<{ kind: string; text: string }> }
        | undefined;
      expect(details?.fragments).toEqual(
        expect.arrayContaining([
          { kind: "conversation-data", text: compactInbound },
          { kind: "runtime-instruction", text: directive },
        ]),
      );
      expect(
        details?.fragments?.filter(
          (fragment) => fragment.kind === "conversation-data" && fragment.text.includes(directive),
        ),
      ).toEqual([]);
    });

    it("keeps a producer's instruction fragments when the context has no compact projection", async () => {
      const replyInstruction = "Reply with a short summary of the finished subagent run.";
      const fixture = createInput({
        attempt: createAttempt({
          currentInboundContext: {
            text: `${verboseInbound}\n\n${replyInstruction}`,
            fragments: [
              { kind: "conversation-data", text: verboseInbound },
              { kind: "runtime-instruction", text: replyInstruction },
            ],
          },
        }),
      });

      const result = await prepareContext({
        ...fixture.input,
        contextSerialization: compactSerialization,
        sessionVersion: 4,
      });

      const details = result.runtimeContextMessageForCurrentTurn?.details as
        | { fragments?: Array<{ kind: string; text: string }> }
        | undefined;
      expect(details?.fragments).toEqual(
        expect.arrayContaining([
          { kind: "conversation-data", text: verboseInbound },
          { kind: "runtime-instruction", text: replyInstruction },
        ]),
      );
      expect(
        details?.fragments?.filter(
          (fragment) =>
            fragment.kind === "conversation-data" && fragment.text.includes(replyInstruction),
        ),
      ).toEqual([]);
    });
  });

  it("keeps the live orphan-repair heartbeat task active without parsing its marker", async () => {
    const taskPrompt = "Check the deployment and report any failures.";
    const transcriptPrompt = "[OpenClaw heartbeat poll]";
    const mergedModelPrompt = [QUEUED_USER_MESSAGE_MARKER, transcriptPrompt, "", taskPrompt].join(
      "\n",
    );
    const fixture = createInput({
      attempt: createAttempt({ currentInboundContext: undefined }),
      prompt: createPrompt({
        effectivePrompt: mergedModelPrompt,
        effectiveTranscriptPrompt: transcriptPrompt,
      }),
    });

    const result = await prepareContext(fixture.input);

    expect(result.promptForSession).toBe(transcriptPrompt);
    expect(result.promptForModel).toBe(mergedModelPrompt);
    expect(result.promptSubmission.runtimeContext).toBeUndefined();
    expect(result.runtimeContextMessageForCurrentTurn).toMatchObject({
      content: temporalContext,
      display: false,
    });
  });

  it("rebases prePromptMessageCount and updates session messages when replay normalization shrinks history", async () => {
    const rawHistory: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "Historic question" }], timestamp: 10 },
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "NO_REPLY" }],
        timestamp: 11,
      }),
      { role: "user", content: [{ type: "text", text: "Follow-up" }], timestamp: 12 },
    ];
    const fixture = createInput({ messages: rawHistory });

    const result = await prepareContext(fixture.input);

    expect(rawHistory.length).toBe(3);
    expect(result.prePromptMessageCount).toBe(2);
    expect(fixture.replaceSessionMessages).toHaveBeenCalledWith([rawHistory[0], rawHistory[2]]);
  });

  it("preserves ordinary reply text containing a trailing silence token without rewriting history", async () => {
    const contentModifiedHistory: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "Historic question" }], timestamp: 10 },
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "Slides ready" },
          { type: "text", text: "NO_REPLY" },
        ],
        timestamp: 11,
      }),
    ];
    const fixture = createInput({ messages: contentModifiedHistory });

    const result = await prepareContext(fixture.input);

    expect(result.prePromptMessageCount).toBe(2);
    expect(fixture.replaceSessionMessages).not.toHaveBeenCalled();
    expect(contentModifiedHistory[1]).toMatchObject({
      content: [
        { type: "text", text: "Slides ready" },
        { type: "text", text: "NO_REPLY" },
      ],
    });
  });
});
