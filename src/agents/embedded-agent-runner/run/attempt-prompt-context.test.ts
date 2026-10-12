import { QUEUED_USER_MESSAGE_MARKER } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import * as execApprovals from "../../../infra/exec-approvals.js";
import { withMockedPlatform } from "../../../test-utils/vitest-spies.js";
import { addSession, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import * as mediaTaskStatus from "../../media-generation-task-status.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../../subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../subagents/registry/subagent-registry.types.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  info: vi.fn(),
  promptPressureKeys: new Set<string>(),
  reconcileToolResultPromptProjectionState: vi.fn(),
  resolveLiveToolResultAggregateMaxChars: vi.fn(() => 200),
  resolveLiveToolResultMaxChars: vi.fn(() => 100),
  truncateOversizedToolResultsInMessages: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { info: hoisted.info, warn: hoisted.warn },
}));
vi.mock("../tool-result-truncation.js", () => ({
  resolveLiveToolResultAggregateMaxChars: hoisted.resolveLiveToolResultAggregateMaxChars,
  resolveLiveToolResultMaxChars: hoisted.resolveLiveToolResultMaxChars,
  reconcileToolResultPromptProjectionState: hoisted.reconcileToolResultPromptProjectionState,
  toolResultWarningDedupe: {
    promptPressure: {
      check: (key: string) => {
        if (hoisted.promptPressureKeys.has(key)) {
          return true;
        }
        hoisted.promptPressureKeys.add(key);
        return false;
      },
    },
  },
  truncateOversizedToolResultsInMessages: hoisted.truncateOversizedToolResultsInMessages,
}));

import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-build.js";

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

type PromptInput = Parameters<typeof prepareEmbeddedAttemptPromptContext>[0]["prompt"];

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
  return {
    input: {
      attempt: options?.attempt ?? createAttempt({ trigger: "user" }),
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
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T12:00:00Z"));
  vi.spyOn(mediaTaskStatus, "buildMediaTaskRuntimeContext").mockResolvedValue(undefined);
  await resetSubagentRegistryForTests({ persist: false });
  hoisted.promptPressureKeys.clear();
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
});

describe("prepareEmbeddedAttemptPromptContext", () => {
  it("carries current Windows approval hints without changing system or user prompt bytes", () =>
    withMockedPlatform("win32", async () => {
      const load = vi
        .spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync")
        .mockResolvedValue({ version: 1 });
      const fixture = createInput();
      fixture.input.capabilityToolNames.add("exec");
      const before = await prepareEmbeddedAttemptPromptContext(fixture.input);
      load.mockResolvedValue({
        version: 1,
        agents: { "agent-1": { allowlist: [{ pattern: "C:\\Tools\\node.exe" }] } },
      });
      const after = await prepareEmbeddedAttemptPromptContext(fixture.input);
      expect(before.runtimeContextMessageForCurrentTurn?.content ?? "").not.toContain(
        "## Approved executables",
      );
      expect(after.runtimeContextMessageForCurrentTurn?.content).toContain(
        "C:\\Tools\\node.exe (any arguments)",
      );
      expect(after.systemPromptForHook).toBe(before.systemPromptForHook);
      expect(after.promptForSession).toBe(before.promptForSession);
    }));
  it("carries execution-owned processes in id order without elapsed time or output", async () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames.add("process");
    const idle = await prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(idle.runtimeContextMessageForCurrentTurn?.content ?? "").not.toContain(
      "Active exec sessions:",
    );
    for (const id of ["exec-z", "exec-a"]) {
      const session = createProcessSessionFixture({ id, backgrounded: true });
      session.scopeKey = fixture.input.attempt.sessionKey;
      session.tail = "private output tail";
      addSession(session);
    }
    const active = await prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(active.systemPromptForHook).toBe(idle.systemPromptForHook);
    const content = active.runtimeContextMessageForCurrentTurn?.content;
    expect(content).toContain("Active exec sessions:");
    expect(content).toContain("exec-a running");
    expect(content!.indexOf("exec-a")).toBeLessThan(content!.indexOf("exec-z"));
    expect(content).not.toMatch(/private output tail|runtimeMs|startedAt/);
    expect(active.runtimeContextMessageForCurrentTurn?.details.fragments).toContainEqual({
      kind: "conversation-data",
      text: expect.stringContaining("Active exec sessions:"),
    });
    expect(active.promptForSession).toBe("Visible request");
  });

  it("carries changed subagent status without rewriting the system prompt", async () => {
    const fixture = createInput();
    fixture.input.sessionAgentId = "main";
    fixture.input.capabilityToolNames.add("sessions_spawn");
    const run = {
      runId: "run-worker",
      childSessionKey: "agent:main:subagent:worker",
      controllerSessionKey: fixture.input.attempt.sessionKey!,
      requesterSessionKey: fixture.input.attempt.sessionKey!,
      requesterDisplayKey: "main",
      task: "Inspect fixtures",
      label: "Worker",
      cleanup: "keep",
      createdAt: 1,
      execution: { status: "queued" },
    } satisfies SubagentRunRecord;
    seedSubagentRunForReadTest(run);
    const queued = await prepareEmbeddedAttemptPromptContext(fixture.input);
    seedSubagentRunForReadTest({ ...run, execution: { status: "running", startedAt: 2 } });
    const running = await prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(running.systemPromptForHook).toBe(queued.systemPromptForHook);
    expect(queued.runtimeContextMessageForCurrentTurn?.content).toContain("status=queued");
    expect(running.runtimeContextMessageForCurrentTurn?.content).toContain("status=running");
    await resetSubagentRegistryForTests({ persist: false });
    const completed = await prepareEmbeddedAttemptPromptContext(fixture.input);
    expect(completed.runtimeContextMessageForCurrentTurn?.content ?? "").not.toContain(
      "## Active Subagents",
    );
  });

  it("supersedes retained active facts with explicit empty snapshots", async () => {
    const fixture = createInput();
    fixture.input.capabilityToolNames = new Set(["process", "sessions_spawn", "image_generate"]);
    const process = createProcessSessionFixture({ id: "exec-a", backgrounded: true });
    process.scopeKey = fixture.input.attempt.sessionKey;
    addSession(process);
    vi.mocked(mediaTaskStatus.buildMediaTaskRuntimeContext).mockResolvedValue(
      "## Media Generation Tasks\n- tool=image_generate; task=image-1; status=running",
    );
    const active = await prepareEmbeddedAttemptPromptContext(fixture.input);
    deleteSession("exec-a");
    vi.mocked(mediaTaskStatus.buildMediaTaskRuntimeContext).mockResolvedValue(
      "## Media Generation Tasks\n- tool=image_generate; none",
    );
    const empty = await prepareEmbeddedAttemptPromptContext({
      ...fixture.input,
      appendOnlyRuntimeContext: true,
      messages: [...messages, active.runtimeContextMessageForCurrentTurn!],
    });
    expect(empty.systemPromptForHook).toBe(active.systemPromptForHook);
    expect(empty.runtimeContextMessageForCurrentTurn?.content).toContain(
      "Active exec sessions:\nnone",
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
    const result = await prepareEmbeddedAttemptPromptContext({
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

    const result = await prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.llmBoundaryPromptForPrecheck).toContain('"name":"Alice"');
    expect(result.llmBoundaryPromptForPrecheck).toContain("Visible request");
  });

  it("does not reconcile session projection state for raw probes", async () => {
    const fixture = createInput();

    await prepareEmbeddedAttemptPromptContext({ ...fixture.input, isRawModelRun: true });

    expect(hoisted.reconcileToolResultPromptProjectionState).not.toHaveBeenCalled();
  });

  it("reports aggregate tool-result pressure for compact-then-truncate routing", async () => {
    hoisted.truncateOversizedToolResultsInMessages.mockImplementation((inputMessages) => ({
      messages: [...inputMessages],
      truncatedCount: 2,
      aggregateTruncatedCount: 1,
      aggregatePressureEngaged: true,
      aggregateBudgetChars: 200,
    }));
    const fixture = createInput({
      attempt: createAttempt({ sessionId: "pressure-session", sessionKey: "pressure-session" }),
    });

    const result = await prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.aggregatePressureEngaged).toBe(true);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("aggregate tool-result pressure"),
    );
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
      const result = await prepareEmbeddedAttemptPromptContext({
        ...fixture.input,
        sessionVersion,
      });

      expect(result.systemPromptForHook).toBe("Base system prompt");
      expect(result.systemPromptForHook).not.toContain("OpenClaw runtime event.");
      expect(result.systemPromptForHook).not.toContain("Runtime room event");
      expect(result.promptSubmission.runtimeOnly).toBe(true);
      expect(result.promptForSession).toBe("Continue the OpenClaw runtime event.");
      expect(result.promptForModel).toBe(result.promptForSession);
      expect(result.systemPromptForHook).not.toContain("Room conversation data");
      expect(result.runtimeContextMessageForCurrentTurn?.content ?? "").not.toContain(
        "Active exec sessions:",
      );
      expect(result.runtimeContextMessageForCurrentTurn?.content).toContain("Runtime room event");
      expect(result.runtimeContextMessageForCurrentTurn?.content).toContain(
        "Room conversation data",
      );
      expect(fixture.report.currentTurn?.kind).toBe("room_event");
      expect(fixture.report.currentTurn?.runtimeContextChars).toBeGreaterThan(0);
    },
  );

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

    const result = await prepareEmbeddedAttemptPromptContext(fixture.input);

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

    const result = await prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(rawHistory.length).toBe(3);
    expect(result.prePromptMessageCount).toBe(2);
    expect(fixture.replaceSessionMessages).toHaveBeenCalledWith([rawHistory[0], rawHistory[2]]);
  });

  it("updates session messages when replay normalization modifies content without changing count", async () => {
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

    const result = await prepareEmbeddedAttemptPromptContext(fixture.input);

    expect(result.prePromptMessageCount).toBe(2);
    expect(fixture.replaceSessionMessages).toHaveBeenCalledWith([
      contentModifiedHistory[0],
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Slides ready" }],
      }),
    ]);
  });
});
