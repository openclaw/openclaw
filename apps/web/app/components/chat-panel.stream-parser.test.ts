import { describe, expect, it } from "vitest";
import { createStreamParser } from "./chat-panel";

describe("createStreamParser", () => {
  it("treats user-message as turn boundary and keeps user/assistant sequence stable", () => {
    const parser = createStreamParser();

    parser.processEvent({ type: "user-message", id: "u-1", text: "Draft an email" });
    parser.processEvent({ type: "text-start" });
    parser.processEvent({ type: "text-delta", delta: "Sure — drafting now." });
    parser.processEvent({ type: "text-end" });
    parser.processEvent({ type: "user-message", id: "u-2", text: "Also include follow-up" });
    parser.processEvent({ type: "text-start" });
    parser.processEvent({ type: "text-delta", delta: "Added a follow-up section." });
    parser.processEvent({ type: "text-end" });

    expect(parser.getParts()).toEqual([
      { type: "user-message", id: "u-1", text: "Draft an email" },
      { type: "text", text: "Sure — drafting now." },
      { type: "user-message", id: "u-2", text: "Also include follow-up" },
      { type: "text", text: "Added a follow-up section." },
    ]);
  });

  it("accumulates tool input/output by toolCallId and preserves terminal status", () => {
    const parser = createStreamParser();

    parser.processEvent({
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "searchDocs",
    });
    parser.processEvent({
      type: "tool-input-available",
      toolCallId: "tool-1",
      input: { query: "workspace lock" },
    });
    parser.processEvent({
      type: "tool-output-available",
      toolCallId: "tool-1",
      output: { hits: 3 },
    });

    parser.processEvent({
      type: "tool-input-start",
      toolCallId: "tool-2",
      toolName: "writeFile",
    });
    parser.processEvent({
      type: "tool-output-error",
      toolCallId: "tool-2",
      errorText: "permission denied",
    });

    expect(parser.getParts()).toEqual([
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "searchDocs",
        state: "output-available",
        input: { query: "workspace lock" },
        output: { hits: 3 },
      },
      {
        type: "dynamic-tool",
        toolCallId: "tool-2",
        toolName: "writeFile",
        state: "error",
        input: {},
        output: { error: "permission denied" },
      },
    ]);
  });

  it("keeps partial tool output visible without marking the tool complete", () => {
    const parser = createStreamParser();

    parser.processEvent({
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "readFile",
    });
    parser.processEvent({
      type: "tool-output-partial",
      toolCallId: "tool-1",
      output: { text: "first chunk" },
    });

    expect(parser.getParts()).toEqual([
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "readFile",
        state: "input-available",
        input: {},
        output: { text: "first chunk" },
        preliminary: true,
      },
    ]);
  });

  it("closes reasoning state on reasoning-end to prevent stuck streaming badges", () => {
    const parser = createStreamParser();

    parser.processEvent({ type: "reasoning-start" });
    parser.processEvent({ type: "reasoning-delta", delta: "Planning edits..." });
    parser.processEvent({ type: "reasoning-end" });

    expect(parser.getParts()).toEqual([
      { type: "reasoning", text: "Planning edits..." },
    ]);
  });

  it("ignores unknown events without corrupting previously parsed parts", () => {
    const parser = createStreamParser();

    parser.processEvent({ type: "text-start" });
    parser.processEvent({ type: "text-delta", delta: "Stable output" });
    parser.processEvent({ type: "unrecognized-event", payload: "noise" });
    parser.processEvent({ type: "text-end" });

    expect(parser.getParts()).toEqual([{ type: "text", text: "Stable output" }]);
  });
});
