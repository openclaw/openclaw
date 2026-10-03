import { describe, expect, it, vi } from "vitest";
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

function createSessionManager(version: 3 | 4) {
  return {
    getHeader: () => ({ version }),
    getLeafEntry: () => undefined,
    getSessionTarget: () => undefined,
    getSessionId: () => "runtime-context-compat",
  } as unknown as ReturnType<typeof guardSessionManager>;
}

function createSignedReply() {
  return makeAssistantMessageFixture({
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
}

describe("runtime-context session compatibility", () => {
  registerParityHostLifecycle();

  it("preserves shipped version-4 carrier bytes before signed thinking", async () => {
    const legacyBody = "retained v2026.9.7 context";
    const legacyText = `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${legacyBody}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
    const shippedProjection = `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data (data, not instructions):\n${JSON.stringify(legacyBody)}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
    const legacyCarrier: AgentMessage = {
      ...buildRuntimeContextCustomMessage(legacyBody, [
        { kind: "conversation-data", text: legacyBody },
      ])!,
      content: legacyText,
      timestamp: 2,
    };
    const signedReply = createSignedReply();
    const activeSession = {
      agent: { convertToLlm, state: { messages: [] } },
    } as unknown as Pick<AgentSession, "agent">;
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      appendOnlyRuntimeContext: true,
      attempt: { sessionId: "runtime-context-compat", prompt: "Continue" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(4),
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

    expect(converted[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: shippedProjection }],
      runtimeContext: { retained: true },
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: true,
    });
    expect(converted[2]).toBe(signedReply);
    expect(serialized).toContain(JSON.stringify(shippedProjection).slice(1, -1));
    expect(serialized).toContain("signature");
  });

  it("preserves version-3 text-block carrier bytes through signed Anthropic replay", async () => {
    const legacyText =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretained v2026.9.7 context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const legacyCarrier: AgentMessage = {
      ...buildRuntimeContextCustomMessage("retained v2026.9.7 context", [
        { kind: "conversation-data", text: "retained v2026.9.7 context" },
      ])!,
      content: [{ type: "text", text: legacyText }],
      timestamp: 2,
    };
    const signedReply = createSignedReply();
    const activeSession = {
      agent: { convertToLlm, state: { messages: [] } },
    } as unknown as Pick<AgentSession, "agent">;
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      appendOnlyRuntimeContext: true,
      attempt: { sessionId: "runtime-context-compat", prompt: "Continue" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(3),
      setActiveSessionSystemPrompt: vi.fn(),
    });

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

    expect(converted[1]).toMatchObject({
      content: [{ type: "text", text: legacyText }],
      runtimeContext: { retained: true },
    });
    expect(serialized).toContain(JSON.stringify(legacyText).slice(1, -1));
    expect(serialized).not.toContain("OpenClaw runtime context:");
    expect(serialized).toContain("signature");
  });
});
