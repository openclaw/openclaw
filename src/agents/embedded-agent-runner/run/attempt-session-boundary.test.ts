import { describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../../../auto-reply/reply/inbound-context-marker.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import { labelRuntimeContextText } from "../../../llm/types.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm as convertHarnessMessages } from "../../sessions/messages.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { beginPromptCacheObservation } from "../prompt-cache-observability.js";
import {
  createActiveSession,
  createSessionManager,
} from "./attempt-session-boundary.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

describe("prepareEmbeddedAttemptSessionBoundary", () => {
  it("strips persisted carriers when a session switches to transient replay", async () => {
    const previousUser: AgentMessage = { role: "user", content: "first question", timestamp: 1 };
    const previousCarrier: AgentMessage = buildRuntimeContextCustomMessage("persisted context")!;
    previousCarrier.details = { runtimeContextCarrier: true };
    const reply = makeAssistantMessageFixture({
      content: [{ type: "text", text: "first answer" }],
    });
    const currentCarrier = buildRuntimeContextCustomMessage("current context")!;
    const currentUser: AgentMessage = { role: "user", content: "next question", timestamp: 2 };
    const messages = [previousUser, previousCarrier, reply, currentCarrier, currentUser];
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      appendOnlyRuntimeContext: false,
      attempt: { sessionId: "session-boundary", prompt: "next question" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });
    const converted = await activeSession.agent.convertToLlm(messages);
    expect(converted).toHaveLength(4);
    expect(converted).not.toContain(previousCarrier);
    expect(converted.at(-1)).toBe(currentCarrier);
    expect(converted.slice(0, -1)).not.toContain(currentCarrier);
    expect(await activeSession.agent.convertToLlm(messages)).toEqual(converted);
  });

  it.each([false, true])(
    "replays turn and tool-loop prefixes with append-only runtime context %s",
    async (appendOnlyRuntimeContext) =>
      withEnvAsync({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, async () => {
        const { activeSession } = createActiveSession();
        activeSession.agent.convertToLlm = convertHarnessMessages;
        const sessionId = `boundary-cache-${appendOnlyRuntimeContext}`;
        const observe = (messages: Parameters<typeof beginPromptCacheObservation>[0]["messages"]) =>
          beginPromptCacheObservation({
            sessionId,
            provider: "test-provider",
            modelId: "test-model",
            streamStrategy: "test",
            systemPrompt: "Stable system prompt",
            tools: [],
            messages,
          });
        await prepareEmbeddedAttemptSessionBoundary({
          activeSession,
          appendOnlyRuntimeContext,
          attempt: {
            sessionId,
            config: { agents: { defaults: { userTimezone: "UTC" } } },
            prompt: "first question",
          },
          getUserTranscriptContexts: () => undefined,
          isRawModelRun: false,
          preparedUserTurnMessage: undefined,
          sessionManager: createSessionManager(),
          setActiveSessionSystemPrompt: vi.fn(),
        });
        const user = {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `${markInboundContextLabel("Conversation info:")}\n\`\`\`json\n{"channel":"discord"}\n\`\`\`\n\nfirst question`,
            },
          ],
          timestamp: 1_717_570_800_000,
        };
        const carrier = buildRuntimeContextCustomMessage("first turn context")!;
        const messages: AgentMessage[] = appendOnlyRuntimeContext
          ? [user, carrier]
          : [carrier, user];
        const first = await activeSession.agent.convertToLlm(messages);
        expect(observe(first).changes).toBeNull();
        expect(first).toHaveLength(2);
        expect(first[1]).toMatchObject({
          role: "user",
          content: labelRuntimeContextText(carrier.content),
          runtimeContext: { retained: appendOnlyRuntimeContext },
          runtimeContextCarrier: true,
          runtimeContextCarrierRetained: appendOnlyRuntimeContext,
        });
        messages.push(
          makeAssistantMessageFixture({
            content: [{ type: "toolCall", id: "call_read", name: "read", arguments: {} }],
            stopReason: "toolUse",
          }),
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read",
            content: [{ type: "text", text: "result" }],
            isError: false,
            timestamp: user.timestamp + 1,
          },
        );
        const toolLoop = await activeSession.agent.convertToLlm(messages);
        expect(observe(toolLoop).changes).toEqual(
          appendOnlyRuntimeContext
            ? null
            : [expect.objectContaining({ code: "runtimeContextCarrier" })],
        );
        if (appendOnlyRuntimeContext) {
          expect(JSON.stringify(toolLoop.slice(0, first.length))).toBe(JSON.stringify(first));
        } else {
          expect(toolLoop.at(-1)).toEqual(first[1]);
        }
        expect(observe(await activeSession.agent.convertToLlm(messages)).changes).toBeNull();
        const nextUser = {
          role: "user" as const,
          content: "next question",
          timestamp: user.timestamp + 60_000,
        };
        const nextCarrier = buildRuntimeContextCustomMessage("second turn context")!;
        messages.push(makeAssistantMessageFixture({ content: [{ type: "text", text: "done" }] }));
        messages.push(
          ...(appendOnlyRuntimeContext ? [nextUser, nextCarrier] : [nextCarrier, nextUser]),
        );
        const next = await activeSession.agent.convertToLlm(messages);
        expect(observe(next).changes).toEqual(
          appendOnlyRuntimeContext
            ? null
            : [expect.objectContaining({ code: "runtimeContextCarrier" })],
        );
        if (appendOnlyRuntimeContext) {
          expect(JSON.stringify(next.slice(0, toolLoop.length))).toBe(JSON.stringify(toolLoop));
          expect(next[1]).toEqual(first[1]);
          expect(next[0]!.content).toContain("Conversation info:");
        } else {
          expect(next).not.toContainEqual(first[1]);
          expect(next[0]!.content).toContain("Conversation info:");
        }
        expect(next.at(-1)).toMatchObject({
          role: "user",
          content: labelRuntimeContextText(nextCarrier.content),
        });
      }),
  );

  it("resets restored state and preserves exact prompt bytes for raw model probes", async () => {
    const { activeSession, reset } = createActiveSession();
    const setActiveSessionSystemPrompt = vi.fn();

    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { sessionId: "session-boundary", prompt: "exact probe" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: true,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt,
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "exact probe" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).toHaveBeenCalledOnce();
    expect(setActiveSessionSystemPrompt).toHaveBeenCalledWith("");
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("exact probe");
    expect((converted[0] as { content?: unknown }).content).not.toContain("Conversation info");
  });

  it("preserves settled history while isolating the finalization prompt", async () => {
    const { activeSession, reset } = createActiveSession();
    const sessionManager = createSessionManager({
      getLeafEntry: () => ({
        id: "user-leaf",
        parentId: "parent-entry",
        type: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
    });
    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        sessionId: "session-boundary",
        operation: "settled-tool-finalization",
        prompt: "finalize exactly",
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager,
      setActiveSessionSystemPrompt: vi.fn(),
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "finalize exactly" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).not.toHaveBeenCalled();
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("finalize exactly");
  });

  it("applies the prepared current-turn timestamp at the LLM boundary", async () => {
    const { activeSession } = createActiveSession();
    const preparedTimestamp = 1_717_570_800_000;
    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        sessionId: "session-boundary",
        config: { agents: { defaults: { userTimezone: "UTC" } } },
        prompt: "Current ask",
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });
    boundary.setCurrentUserTimestampOverride({
      timestamp: preparedTimestamp,
      text: "Current ask",
    });

    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "Current ask" }],
        timestamp: preparedTimestamp + 60_000,
      },
    ]);

    expect((converted[0] as { content?: unknown }).content).toBe(
      `${buildTimestampPrefix(new Date(preparedTimestamp), { timezone: "UTC" })}Current ask`,
    );
  });

  it("retains sender projection for earlier in-memory turns after a queued turn", async () => {
    const initialRuntime = {
      role: "user",
      content: [{ type: "text", text: "The launch is Friday" }],
      timestamp: 1,
    } as AgentMessage;
    const queuedRuntime = {
      role: "user",
      content: [{ type: "text", text: "I can present it" }],
      timestamp: 2,
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { sessionId: "session-boundary", prompt: "The launch is Friday" },
      getUserTranscriptContexts: () => [
        {
          runtimeMessage: initialRuntime,
          transcriptMessage: {
            role: "user",
            content: "The launch is Friday",
            timestamp: 1,
            __openclaw: { senderId: "alice-id", senderName: "Alice" },
          } as AgentMessage,
        },
        {
          runtimeMessage: queuedRuntime,
          transcriptMessage: {
            role: "user",
            content: "I can present it",
            timestamp: 2,
            __openclaw: { senderId: "bob-id", senderName: "Bob" },
          } as AgentMessage,
        },
      ],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const converted = await activeSession.agent.convertToLlm([initialRuntime, queuedRuntime]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name":"Alice"');
    expect((converted[1] as { content?: unknown }).content).toContain('"name":"Bob"');
  });

  it("reserves exact pairings before matching duplicate timestamp and text", async () => {
    const firstRuntime = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    } as AgentMessage;
    const secondRuntime = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { sessionId: "session-boundary", prompt: "same" },
      getUserTranscriptContexts: () => [
        {
          runtimeMessage: secondRuntime,
          transcriptMessage: {
            role: "user",
            content: "same",
            timestamp: 1,
            __openclaw: { senderName: "Bob" },
          } as AgentMessage,
        },
        {
          runtimeMessage: firstRuntime,
          transcriptMessage: {
            role: "user",
            content: "same",
            timestamp: 1,
            __openclaw: { senderName: "Alice" },
          } as AgentMessage,
        },
      ],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const converted = await activeSession.agent.convertToLlm([firstRuntime, secondRuntime]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name":"Alice"');
    expect((converted[1] as { content?: unknown }).content).toContain('"name":"Bob"');
  });
});
