import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { qaSuiteTesting } from "./suite.js";

describe("qa suite failure reply handling", () => {
  it("detects classified failure replies before a success-only outbound predicate matches", async () => {
    const state = createQaBusState();
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    const message = qaSuiteTesting.findFailureOutboundMessage(state);
    expect(message?.text).toContain("Something went wrong while processing your request.");
  });

  it("fails success-only waitForOutboundMessage calls when a classified failure reply arrives first", async () => {
    const state = createQaBusState();
    const pending = qaSuiteTesting.waitForOutboundMessage(
      state,
      (candidate) =>
        candidate.conversation.id === "qa-operator" &&
        candidate.text.includes("Remembered ALPHA-7."),
      5_000,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("fails raw scenario waitForCondition calls when a classified failure reply arrives", async () => {
    const state = createQaBusState();
    const waitForCondition = qaSuiteTesting.createScenarioWaitForCondition(state);

    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("ALPHA-7"),
          )
          .at(-1),
      5_000,
      10,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("fails raw scenario waitForCondition calls even when mixed traffic already exists", async () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "hello",
    });
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "working on it",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "ok do it",
    });

    const waitForCondition = qaSuiteTesting.createScenarioWaitForCondition(state);
    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.slice(3)
          .filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("mission"),
          )
          .at(-1),
      150,
      10,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });
});
