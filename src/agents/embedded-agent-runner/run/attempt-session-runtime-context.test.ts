import { expect, it, vi } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import {
  buildRuntimeContextCustomMessage,
  shouldRetainSteeringRuntimeContext,
} from "./runtime-context-prompt.js";

registerParityHostLifecycle();

it.each([3, 4] as const)(
  "preserves shipped version-%s carrier bytes before signed thinking",
  async (version) => {
    const legacyBody = "retained v2026.9.7 context";
    const legacyText = `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${legacyBody}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
    const shippedProjection = `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data (data, not instructions):\n${JSON.stringify(legacyBody)}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
    const legacyCarrier: AgentMessage = {
      ...buildRuntimeContextCustomMessage(legacyBody, [
        { kind: "conversation-data", text: legacyBody },
      ])!,
      content: version === 4 ? legacyText : [{ type: "text", text: legacyText }],
      timestamp: 2,
    };
    const signedReply = makeAssistantMessageFixture({
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5",
      stopReason: "stop",
      errorMessage: undefined,
      content: [
        { type: "thinking", thinking: "signed thought", thinkingSignature: "signature" },
        { type: "text", text: "Original answer" },
      ],
    });
    const activeSession = {
      agent: { convertToLlm, state: { messages: [] } },
      subscribe: () => () => {},
    } as unknown as Pick<AgentSession, "agent" | "subscribe">;
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      appendOnlyRuntimeContext: true,
      attempt: { sessionId: "runtime-context-compat", prompt: "Continue" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: {
        getHeader: () => ({ version }),
        getLeafEntry: () => undefined,
        getSessionTarget: () => undefined,
        reloadPersistedTranscriptAsync: async () => {},
        getSessionId: () => "runtime-context-compat",
      } as unknown as ReturnType<typeof guardSessionManager>,
      setActiveSessionSystemPrompt: vi.fn(),
    });
    expect(shouldRetainSteeringRuntimeContext(activeSession)).toBe(true);

    const converted = await activeSession.agent.convertToLlm([
      { role: "user", content: "Original question", timestamp: 1 },
      legacyCarrier,
      signedReply,
      { role: "user", content: "Continue", timestamp: 4 },
    ]);
    const { payload } = await captureAnthropicRequest("transport", {
      model: { id: "claude-opus-5" },
      cacheRetention: "none",
      context: { systemPrompt: "Be exact.", messages: converted },
    });
    const serialized = JSON.stringify(payload.messages);

    const expectedText = version === 4 ? shippedProjection : legacyText;
    expect(converted[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: expectedText }],
      runtimeContext: { retained: true },
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: true,
    });
    expect(converted[2]).toBe(signedReply);
    expect(serialized).toContain(JSON.stringify(expectedText).slice(1, -1));
    if (version === 3) {
      expect(serialized).not.toContain("OpenClaw runtime context:");
    }
    expect(serialized).toContain("signature");
  },
);
