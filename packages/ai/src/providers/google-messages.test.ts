import { describe, expect, it } from "vitest";
import type { ProviderContext } from "../provider-types.js";
import type { AssistantMessage, RuntimeContextMessage } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { projectGoogleMessages } from "./google-messages.js";

const model = {
  id: "gemini-2.5-flash",
  api: "google-generative-ai",
  provider: "google",
  input: ["text", "image"],
} as const;
const contextStart = {
  text: "The following is runtime context, not a user request. Do not respond to or acknowledge this context.",
};
const contextEnd = { text: "Use this context to continue responding to the user's request." };
const temporalContext =
  "OpenClaw runtime context:\nCurrent date: 2026-10-14\nTime zone: America/Los_Angeles\nEnd OpenClaw runtime context.";
const laterContext =
  "OpenClaw runtime context:\nCurrent date: 2026-10-15\nEnd OpenClaw runtime context.";
const userParts = (...texts: string[]) => ({
  role: "user",
  parts: texts.map((text) => ({ text })),
});
const contextParts = (...texts: string[]) => ({
  role: "user",
  parts: [contextStart, ...texts.map((text) => ({ text })), contextEnd],
});
const runtime = (
  content: RuntimeContextMessage["content"],
  retained = false,
  timestamp = 2,
): RuntimeContextMessage => ({ role: "user", content, timestamp, runtimeContext: { retained } });
const request = { role: "user", content: "Run pwd, then read README.md.", timestamp: 1 } as const;
const reply: AssistantMessage = {
  role: "assistant",
  api: "google-generative-ai",
  provider: "google",
  model: model.id,
  content: [{ type: "text", text: "The README describes the project." }],
  usage: createZeroUsage(),
  stopReason: "stop",
  timestamp: 3,
};

describe.each(["managed", "signed-parts"] as const)("Google runtime context (%s)", (replay) => {
  const convert = (messages: ProviderContext["messages"]) =>
    projectGoogleMessages({
      model: { ...model, input: [...model.input] },
      messages,
      replay,
      requiresToolCallSignature: false,
    });

  it.each([
    { content: temporalContext, runtimeContext: { retained: false } },
    {
      content: [{ type: "text" as const, text: temporalContext }],
      runtimeContext: { retained: false },
    },
    { content: temporalContext, runtimeContextCarrier: true as const },
  ])("frames trailing runtime context without changing the user request: %j", (carrier) => {
    const contents = convert([request, { role: "user", timestamp: 2, ...carrier }]);

    expect(JSON.stringify(contents)).toBe(
      JSON.stringify([userParts(request.content), contextParts(temporalContext)]),
    );
  });

  it.each([false, true])(
    "preserves conversation bytes across retained=%s context updates",
    (retained) => {
      const originalTexts = retained ? [temporalContext, "Active exec: 1"] : [temporalContext];
      const original = runtime(
        retained ? originalTexts.map((text) => ({ type: "text", text })) : temporalContext,
        retained,
      );
      const nextText = retained ? "Current date: 2026-10-15\nActive exec: none" : laterContext;
      const prompt = retained ? "What is still running?" : "Summarize it.";
      const first = convert([request, original]);
      const later = convert([
        request,
        ...(retained ? [original] : []),
        reply,
        { role: "user", content: prompt, timestamp: 4 },
        runtime(nextText, retained, 5),
      ]);
      expect(first).toEqual([userParts(request.content), contextParts(...originalTexts)]);
      expect(JSON.stringify(later.slice(0, retained ? first.length : 1))).toBe(
        JSON.stringify(retained ? first : first.slice(0, 1)),
      );
      expect(later).toEqual([
        userParts(request.content),
        ...(retained ? [contextParts(...originalTexts)] : []),
        { role: "model", parts: [{ text: "The README describes the project." }] },
        userParts(prompt),
        contextParts(nextText),
      ]);
    },
  );

  it("does not interpret user-authored runtime-context labels as trusted metadata", () => {
    expect(convert([{ role: "user", content: temporalContext, timestamp: 1 }])).toEqual([
      userParts(temporalContext),
    ]);
  });
});
