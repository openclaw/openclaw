import { expectDefined } from "@openclaw/normalization-core";
import type { UserMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import { Agent, type AgentMessage } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  installRuntimeContextMessageForPrompt,
  installModelPromptTransform,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

function createSession() {
  return {
    get messages() {
      return this.agent.state.messages;
    },
    agent: {
      state: { messages: [] as AgentMessage[] },
      continue: async () => undefined,
      transformContext: async (messages: AgentMessage[]) => messages,
    },
  };
}
const originalUser = (): UserMessage => ({ role: "user", content: "original", timestamp: 1 });
const steeringUser = (): UserMessage => ({ role: "user", content: "steering", timestamp: 1 });
const installPrompt = (session: Parameters<typeof installModelPromptTransform>[0]["session"]) =>
  installModelPromptTransform({
    session,
    transcriptPrompt: "original",
    prependContext: "before",
    shouldCapturePrompt: () => true,
  });
const runtimeContext = () =>
  expectDefined(buildRuntimeContextCustomMessage("original context"), "runtime context fixture");

describe("active prompt steering context", () => {
  it("keeps keyless context on the original prompt through pre-prompt rebuilding and initial steering", async () => {
    const manager = SessionManager.inMemory();
    const kept = manager.appendMessage({ role: "user", content: "older request", timestamp: 1 });
    const requests: string[] = [];
    const agent = new Agent({
      initialState: { model: testModel, messages: manager.buildSessionContext().messages },
      streamFn: (model, context) => {
        requests.push(JSON.stringify(context.messages));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "done" }]),
        );
      },
    });
    const session = {
      agent,
      get messages() {
        return agent.state.messages;
      },
    };
    const originalPrompt = agent.prompt.bind(agent);
    agent.prompt = originalPrompt;
    const cleanupPrompt = installPrompt(session);
    const message = runtimeContext();
    const cleanupCarrier = installRuntimeContextMessageForPrompt({ session, message });
    const retainedPrompt = agent.prompt.bind(agent);
    manager.appendCompaction("Older history summarized.", kept, 100);
    agent.state.messages = manager.buildSessionContext().messages;
    agent.steer({ role: "user", content: "steering", timestamp: 2 });
    await agent.prompt({ role: "user", content: "original", timestamp: 2 });
    const activeMessages = agent.state.messages;
    cleanupCarrier();
    cleanupPrompt();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("before\\n\\noriginal");
    expect(requests[0]).not.toContain("before\\n\\nsteering");
    expect(activeMessages).toContain(message);
    expect(agent).toHaveProperty("prompt", originalPrompt);
    await retainedPrompt("later");
    expect(agent.state.messages).not.toContain(message);
  });

  it.each(["keyless", "rewritten key"])(
    "restores the original %s transcript user after actual compaction",
    async (mode) => {
      const original = originalUser();
      const manager = SessionManager.inMemory();
      const contexts = createUserTranscriptContextRegistry();
      const session = createSession();
      const message = runtimeContext();
      const cleanupPrompt = installPrompt(session);
      const cleanup = installRuntimeContextMessageForPrompt({
        session,
        message,
        ...(mode === "rewritten key" ? { persistedUserIdempotencyKey: "before-hook-key" } : {}),
      });
      session.agent.state.messages.push(original);
      const persisted = manager.appendMessageWithTranscriptAnchor({
        ...original,
        ...(mode === "keyless" ? {} : { idempotencyKey: "canonical-key" }),
      });
      contexts.record(original, persisted.message);
      normalizeMessagesForLlmBoundary(await session.agent.transformContext(session.messages), {
        userTranscriptContexts: contexts.list(),
      });
      const steering = manager.appendMessageWithTranscriptAnchor(steeringUser());
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      session.agent.state.messages = manager.buildSessionContext().messages;
      await session.agent.continue();
      const retry = session.messages;
      const projected = await session.agent.transformContext(retry);
      cleanup();
      cleanupPrompt();
      expect(persisted.message).not.toBe(original);
      expect(retry.slice(-3)).toEqual([message, persisted.message, steering.message]);
      expect(projected.at(-2)).toMatchObject({ content: "before\n\noriginal" });
      expect(projected.at(-1)).toBe(steering.message);
      expect(session.messages).not.toContain(message);
    },
  );

  it.each([false, true])(
    "replays a carrierless keyless prompt only with an unambiguous canonical timestamp (ambiguous=%s)",
    async (ambiguous) => {
      const original = originalUser();
      const manager = SessionManager.inMemory();
      const session = createSession();
      const cleanup = installPrompt(session);
      await session.agent.transformContext([original]);
      const persisted = manager.appendMessageWithTranscriptAnchor(original);
      if (ambiguous) {
        manager.appendMessage(steeringUser());
      }
      manager.appendCompaction("Earlier context was summarized.", persisted.entryId, 100);
      const canonical = manager.buildSessionContext().messages;
      const projected = await session.agent.transformContext(canonical);
      cleanup();
      if (ambiguous) {
        expect(projected).toEqual(canonical);
      } else {
        expect(projected.at(-1)).toMatchObject({ content: "before\n\noriginal" });
      }
    },
  );

  it("does not adopt same-time steering after compaction removes the owned prompt", async () => {
    const original = originalUser();
    const session = createSession();
    const cleanupPrompt = installPrompt(session);
    const cleanupCarrier = installRuntimeContextMessageForPrompt({
      session,
      message: runtimeContext(),
    });
    session.agent.state.messages.push(original);
    await session.agent.transformContext(session.messages);
    const manager = SessionManager.inMemory();
    manager.appendMessage(original);
    const kept = manager.appendMessageWithTranscriptAnchor(steeringUser());
    manager.appendCompaction("Original request was summarized.", kept.entryId, 100);
    session.agent.state.messages = manager.buildSessionContext().messages;
    await session.agent.continue();
    const projected = await session.agent.transformContext(session.messages);
    cleanupCarrier();
    cleanupPrompt();
    expect(projected.at(-1)).toBe(kept.message);
  });

  it("preserves the active prompt prefix through steering and retires it on cleanup", () => {
    const session = createSession();
    const message = runtimeContext();
    const cleanup = installRuntimeContextMessageForPrompt({ session, message });
    const promptText =
      'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"channel":"discord"}\n```\n\nOriginal ask';
    session.agent.state.messages.push({
      role: "user",
      content: promptText,
      timestamp: 1717574460000,
    });
    const options = {
      timezone: "UTC",
      currentUserTimestampOverride: { timestamp: 1717570800000, text: promptText },
    };
    const project = () =>
      relocateCurrentRuntimeContextCarrierToTail(
        normalizeMessagesForLlmBoundary(session.messages, options),
      );
    const prefix = project();
    session.agent.state.messages.push(makeUserMessage("new requirement", 1717570860000));
    const steered = project();
    cleanup();
    expect(steered.slice(0, prefix.length)).toEqual(prefix);
    expect(steered.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("new requirement"),
    });
    expect(session.messages).not.toContain(message);
    expect(project()[0]).toMatchObject({
      content: expect.not.stringContaining("Conversation info:"),
    });
    session.agent.state.messages.unshift(message);
    expect(project()).not.toContain(message);
  });

  it("restores the unkeyed source user after an existing context hook projects it", async () => {
    const original = originalUser();
    const steering = steeringUser();
    const session = createSession();
    session.agent.transformContext = async (messages) =>
      messages.map((message) =>
        message.role === "user" ? { ...message, content: "projected" } : message,
      );
    const originalTransform = session.agent.transformContext;
    const cleanupPrompt = installPrompt(session);
    const message = runtimeContext();
    const cleanup = installRuntimeContextMessageForPrompt({ session, message });
    session.agent.state.messages.push(original);
    normalizeMessagesForLlmBoundary(await session.agent.transformContext(session.messages));
    session.agent.state.messages = [original, steering];
    await session.agent.continue();
    const retry = session.messages;
    cleanup();
    cleanupPrompt();
    expect(retry).toEqual([message, original, steering]);
    expect(session.agent.transformContext).toBe(originalTransform);
    expect(session.messages).toEqual([original, steering]);
  });
});
