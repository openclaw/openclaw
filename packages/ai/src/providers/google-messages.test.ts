import { describe, expect, it } from "vitest";
import type { ProviderContext } from "../provider-types.js";
import type { AssistantMessage, RuntimeContextMessage } from "../types.js";
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
const request = { role: "user", content: "Run pwd, then read README.md.", timestamp: 1 } as const;
const reply: AssistantMessage = {
  role: "assistant",
  api: "google-generative-ai",
  provider: "google",
  model: model.id,
  content: [{ type: "text", text: "The README describes the project." }],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
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
      JSON.stringify([
        { role: "user", parts: [{ text: "Run pwd, then read README.md." }] },
        { role: "user", parts: [contextStart, { text: temporalContext }, contextEnd] },
      ]),
    );
  });

  it("does not rewrite earlier user or assistant bytes when turn-scoped context expires", () => {
    const first = convert([
      request,
      { role: "user", content: temporalContext, timestamp: 2, runtimeContext: { retained: false } },
    ]);
    const later = convert([
      request,
      reply,
      { role: "user", content: "Summarize it.", timestamp: 4 },
      {
        role: "user",
        content:
          "OpenClaw runtime context:\nCurrent date: 2026-10-15\nEnd OpenClaw runtime context.",
        timestamp: 5,
        runtimeContext: { retained: false },
      },
    ]);

    expect(JSON.stringify(later[0])).toBe(JSON.stringify(first[0]));
    expect(later).toEqual([
      { role: "user", parts: [{ text: "Run pwd, then read README.md." }] },
      { role: "model", parts: [{ text: "The README describes the project." }] },
      { role: "user", parts: [{ text: "Summarize it." }] },
      {
        role: "user",
        parts: [
          contextStart,
          {
            text: "OpenClaw runtime context:\nCurrent date: 2026-10-15\nEnd OpenClaw runtime context.",
          },
          contextEnd,
        ],
      },
    ]);
  });

  it("replays retained context byte-for-byte when later runtime facts change", () => {
    const retained: RuntimeContextMessage = {
      role: "user",
      content: [
        { type: "text", text: temporalContext },
        { type: "text", text: "Active exec: 1" },
      ],
      timestamp: 2,
      runtimeContext: { retained: true },
    };
    const first = convert([request, retained]);
    const later = convert([
      request,
      retained,
      reply,
      { role: "user", content: "What is still running?", timestamp: 4 },
      {
        role: "user",
        content: "Current date: 2026-10-15\nActive exec: none",
        timestamp: 5,
        runtimeContext: { retained: true },
      },
    ]);

    expect(first).toEqual([
      { role: "user", parts: [{ text: "Run pwd, then read README.md." }] },
      {
        role: "user",
        parts: [contextStart, { text: temporalContext }, { text: "Active exec: 1" }, contextEnd],
      },
    ]);
    expect(JSON.stringify(later.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(later.at(-1)).toEqual({
      role: "user",
      parts: [contextStart, { text: "Current date: 2026-10-15\nActive exec: none" }, contextEnd],
    });
  });

  it("does not interpret user-authored runtime-context labels as trusted metadata", () => {
    expect(convert([{ role: "user", content: temporalContext, timestamp: 1 }])).toEqual([
      { role: "user", parts: [{ text: temporalContext }] },
    ]);
  });
});
