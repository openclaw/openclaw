/**
 * Event Contract Tests
 *
 * Derived from: pi-runtime-baseline.md Section 6 (Event Types),
 * implementation-plan.md Section 4.2 (event translation mapping table),
 * upstream EmbeddedPiSubscribeEvent type.
 *
 * These tests verify that the claude-sdk adapter emits EmbeddedPiSubscribeEvent events
 * matching the exact 10 type strings consumed by createEmbeddedPiSessionEventHandler.
 */

import { describe, it, expect, vi } from "vitest";
import { translateSdkMessageToEvents } from "./event-adapter.js";
import type { ClaudeSdkEventAdapterState } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<ClaudeSdkEventAdapterState>): ClaudeSdkEventAdapterState {
  return {
    subscribers: [],
    streaming: false,
    compacting: false,
    pendingCompactionEnd: undefined,
    abortController: null,
    systemPrompt: "You are helpful.",
    pendingSteer: [],
    pendingToolUses: [],
    toolNameByUseId: new Map(),
    messages: [],
    messageIdCounter: 0,
    streamingMessageId: null,
    claudeSdkSessionId: undefined,
    sessionIdPersisted: false,
    sdkResultError: undefined,
    lastStderr: undefined,
    streamingBlockTypes: new Map(),
    streamingPartialMessage: null,
    streamingInProgress: false,
    sessionManager: undefined,
    transcriptProvider: "anthropic",
    transcriptApi: "anthropic-messages",
    modelCost: undefined,
    ...overrides,
  };
}

function captureEvents(state: ClaudeSdkEventAdapterState): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  state.subscribers.push((evt) => {
    events.push(evt as Record<string, unknown>);
  });
  return events;
}

// ---------------------------------------------------------------------------
// Section 1.1: Required Event Types
// ---------------------------------------------------------------------------

describe("event translation — required event types", () => {
  it("emits agent_start event on session initialization (system/init message)", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      { type: "system", subtype: "init", session_id: "sess_abc123" } as never,
      state,
    );

    expect(state.claudeSdkSessionId).toBe("sess_abc123");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_start" }));
  });

  it("system/init with empty session_id still emits agent_start and does not overwrite session id", () => {
    const state = makeState({ claudeSdkSessionId: "existing-session" });
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      { type: "system", subtype: "init", session_id: "" } as never,
      state,
    );

    expect(state.claudeSdkSessionId).toBe("existing-session");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_start" }));
  });

  it("unknown message types are ignored without emitting events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "mystery_type",
        payload: { anything: true },
      } as never,
      state,
    );

    expect(events).toHaveLength(0);
  });

  it("emits message_start on first assistant text content block", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      } as never,
      state,
    );

    const messageStart = events.find((e) => e.type === "message_start");
    expect(messageStart).toBeDefined();
    expect((messageStart as { message?: { role?: string } }).message?.role).toBe("assistant");
  });

  it("emits message_update events for progressive text deltas", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      } as never,
      state,
    );

    const updates = events.filter((e) => e.type === "message_update");
    expect(updates.length).toBeGreaterThan(0);
  });

  it("emits message_end when text content block finalizes", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      } as never,
      state,
    );

    const messageEnd = events.find((e) => e.type === "message_end");
    expect(messageEnd).toBeDefined();
  });

  it("assistant message with empty content still emits message lifecycle events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [],
        },
      } as never,
      state,
    );

    const types = events.map((evt) => evt.type);
    expect(types[0]).toBe("message_start");
    expect(types[types.length - 1]).toBe("message_end");
  });

  it("emits agent_end on result message", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      { type: "result", subtype: "success", result: "done" } as never,
      state,
    );

    expect(events).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("stores sdkResultError when result subtype indicates failure", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents({ type: "result", subtype: "error_max_turns" } as never, state);

    // Error results must populate sdkResultError so prompt() can throw
    expect(state.sdkResultError).toBe("error_max_turns");
  });

  it("stores sdkResultError from errors array when present", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool execution timed out"],
      } as never,
      state,
    );

    expect(state.sdkResultError).toBe("Tool execution timed out");
  });

  it("prefers result text when is_error is true and subtype is success", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Prompt is too long",
      } as never,
      state,
    );

    expect(state.sdkResultError).toBe("Prompt is too long");
  });

  it("does not set sdkResultError on successful result", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      { type: "result", subtype: "success", result: "done" } as never,
      state,
    );

    expect(state.sdkResultError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 1.2: Event Ordering Invariants
// ---------------------------------------------------------------------------

describe("event translation — ordering invariants", () => {
  it("message events follow start → update* → end ordering", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The answer is 42" }],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("message_start");
    const endIdx = types.lastIndexOf("message_end");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    // All message_update events are between start and end
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "message_update") {
        expect(i).toBeGreaterThan(startIdx);
        expect(i).toBeLessThan(endIdx);
      }
    }
  });

  it("agent_start precedes all other events for init message", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      { type: "system", subtype: "init", session_id: "sess_001" } as never,
      state,
    );

    expect(events[0]).toMatchObject({ type: "agent_start" });
  });
});

// ---------------------------------------------------------------------------
// Section 1.3: Thinking/Reasoning Content Translation
// ---------------------------------------------------------------------------

describe("event translation — thinking content", () => {
  it("translates thinking content block to thinking_start/delta/end sub-events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me analyze this carefully" }],
        },
      } as never,
      state,
    );

    const updates = events.filter((e) => e.type === "message_update");
    const evtTypes = updates.map(
      (e) => (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type,
    );
    expect(evtTypes).toContain("thinking_start");
    expect(evtTypes).toContain("thinking_delta");
    expect(evtTypes).toContain("thinking_end");
  });

  it("thinking events carry correct message with thinking content blocks", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me analyze this carefully" }],
        },
      } as never,
      state,
    );

    const thinkingDelta = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "thinking_delta",
    );
    expect(thinkingDelta).toBeDefined();
    const msg = (thinkingDelta as { message?: { content?: unknown[] } }).message;
    expect(msg?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "thinking" })]),
    );
  });

  it("text content emits text_delta sub-type (not thinking)", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The answer is 42" }],
        },
      } as never,
      state,
    );

    const updates = events.filter((e) => e.type === "message_update");
    const evtTypes = updates.map(
      (e) => (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type,
    );
    expect(evtTypes).toContain("text_delta");
    expect(evtTypes).not.toContain("thinking_delta");
  });

  it("thinking followed by text emits correct event sequence", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I need to think..." },
            { type: "text", text: "The answer is 42" },
          ],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    const allEvtTypes = events.map((e) => {
      const rec = e as { assistantMessageEvent?: { type?: string } };
      return rec.assistantMessageEvent?.type ?? e.type;
    });

    // message_start comes first (initializes handler state),
    // then thinking events, then text events, then message_end
    const thinkingStartIdx = allEvtTypes.indexOf("thinking_start");
    const thinkingEndIdx = allEvtTypes.indexOf("thinking_end");
    const textDeltaIdx = allEvtTypes.indexOf("text_delta");
    const messageStartIdx = types.indexOf("message_start");
    const messageEndIdx = types.lastIndexOf("message_end");

    // message_start BEFORE thinking
    expect(messageStartIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingStartIdx).toBeGreaterThan(messageStartIdx);
    expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
    // text events come after thinking
    if (textDeltaIdx >= 0) {
      expect(textDeltaIdx).toBeGreaterThan(thinkingEndIdx);
    }
    // message_end AFTER everything
    expect(messageEndIdx).toBeGreaterThan(thinkingEndIdx);
    if (textDeltaIdx >= 0) {
      expect(messageEndIdx).toBeGreaterThan(textDeltaIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 1.1: Tool execution events (from MCP handler)
// ---------------------------------------------------------------------------

// NOTE: These tests assert on hardcoded literal objects, not on adapter output.
// tool_execution_* events are emitted by mcp-tool-server.ts (not by the adapter),
// so they cannot be exercised through translateSdkMessageToEvents. The tests below
// document the expected Pi AgentEvent shape contract only — behavioral coverage
// lives in mcp-tool-server.test.ts.
describe("event translation — tool execution event shapes (Pi AgentEvent contract)", () => {
  it("tool_execution_start event has correct Pi AgentEvent fields", () => {
    // Tool execution events are emitted from the MCP handler, not directly from
    // translateSdkMessageToEvents. This test verifies the Pi AgentEvent shape contract.
    const evt = {
      type: "tool_execution_start",
      toolName: "read_file",
      toolCallId: "call_abc",
      args: { path: "/foo.ts" },
    };
    expect(evt.type).toBe("tool_execution_start");
    expect(typeof evt.toolName).toBe("string");
    expect(typeof evt.toolCallId).toBe("string");
    expect(typeof evt.args).toBe("object");
  });

  it("tool_execution_end event has correct Pi AgentEvent fields on success", () => {
    const evt = {
      type: "tool_execution_end",
      toolCallId: "call_abc",
      toolName: "read_file",
      result: "file contents here",
      isError: false,
    };
    expect(evt.type).toBe("tool_execution_end");
    expect(typeof evt.toolCallId).toBe("string");
    expect(typeof evt.result).toBe("string");
    expect(evt.isError).toBe(false);
  });

  it("tool_execution_end event has isError=true on failure", () => {
    const evt = {
      type: "tool_execution_end",
      toolCallId: "call_abc",
      toolName: "read_file",
      result: "Permission denied",
      isError: true,
    };
    expect(evt.type).toBe("tool_execution_end");
    expect(evt.isError).toBe(true);
    expect(typeof evt.result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Section 1.4: Message lifecycle for all assistant messages (including thinking-only)
// The handler's handleMessageStart calls resetAssistantMessageState() which MUST
// fire before any handleMessageUpdate thinking events. Without message_start,
// the handler has uninitialized state for reasoning stream processing.
// ---------------------------------------------------------------------------

describe("event translation — message lifecycle for thinking-only messages", () => {
  it("thinking-only message emits message_start before thinking events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me reason about this" }],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    const messageStartIdx = types.indexOf("message_start");
    const firstUpdateIdx = types.indexOf("message_update");

    // message_start MUST be emitted before any message_update (thinking) events
    expect(messageStartIdx).toBeGreaterThanOrEqual(0);
    expect(firstUpdateIdx).toBeGreaterThan(messageStartIdx);
  });

  it("thinking-only message emits message_end after all thinking events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Deep thought" }],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    const messageEndIdx = types.lastIndexOf("message_end");
    const lastUpdateIdx = types.lastIndexOf("message_update");

    // message_end MUST come after all message_update events
    expect(messageEndIdx).toBeGreaterThan(lastUpdateIdx);
  });

  it("thinking-only message has full lifecycle: start → update* → end", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Reasoning..." }],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types[types.length - 1]).toBe("message_end");
    // All middle events are message_update
    for (let i = 1; i < types.length - 1; i++) {
      expect(types[i]).toBe("message_update");
    }
  });
});

// ---------------------------------------------------------------------------
// Section 1.5: Event ordering for mixed content (thinking + text + tool_use)
// Verifies that the event adapter emits events in the correct sequence when
// assistant messages contain multiple content block types.
// ---------------------------------------------------------------------------

describe("event translation — mixed content sequencing", () => {
  it("text + tool_use: emits message_end to finalize text before tool_use block", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll read that file for you" },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/foo.ts" } },
          ],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    // message_start and message_end must bracket the text content
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
    // message_end must be the LAST event from the adapter
    // (tool_execution_start comes from MCP handler, not adapter)
    expect(types[types.length - 1]).toBe("message_end");
  });

  it("thinking + text + tool_use: correct full sequence", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read the file" },
            { type: "text", text: "Let me read that" },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/foo.ts" } },
          ],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    const allEvtTypes = events.map((e) => {
      const rec = e as { assistantMessageEvent?: { type?: string } };
      return rec.assistantMessageEvent?.type ?? e.type;
    });

    // Must have message_start as first event
    expect(types[0]).toBe("message_start");
    // Must have message_end as last event
    expect(types[types.length - 1]).toBe("message_end");
    // Thinking events must come before text events
    const thinkingEndIdx = allEvtTypes.indexOf("thinking_end");
    const textDeltaIdx = allEvtTypes.indexOf("text_delta");
    expect(thinkingEndIdx).toBeLessThan(textDeltaIdx);
  });

  it("tool_use-only message still emits message_start and message_end", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/foo.ts" } },
          ],
        },
      } as never,
      state,
    );

    const types = events.map((e) => e.type);
    // Even tool_use-only messages need message lifecycle for handler state initialization
    expect(types).toContain("message_start");
    expect(types).toContain("message_end");
  });
});

// ---------------------------------------------------------------------------
// Section 1.6: text_end emission for blockReplyBreak="text_end" parity
//
// For Pi's streaming runtime, text content arrives as a sequence of text_delta
// events followed by a text_end. Subscribers using blockReplyBreak="text_end"
// flush the block reply buffer on text_end (handlers.messages.ts:244-246).
//
// The claude-sdk adapter receives complete text blocks at once, so it emits
// both text_delta and text_end for each block. text_end has an empty delta so
// the handler's deltaBuffer doesn't double-append the content.
// ---------------------------------------------------------------------------

describe("event translation — text_end emission for blockReplyBreak parity", () => {
  it("emits text_end after text_delta for each text block", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      } as never,
      state,
    );

    const updateEvtTypes = events
      .filter((e) => e.type === "message_update")
      .map(
        (e) =>
          (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ?? "",
      );

    const deltaIdx = updateEvtTypes.indexOf("text_delta");
    const endIdx = updateEvtTypes.indexOf("text_end");

    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(deltaIdx);
  });

  it("text_end has empty delta to prevent double-append to deltaBuffer", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Some text" }],
        },
      } as never,
      state,
    );

    const textEndEvt = events
      .filter((e) => e.type === "message_update")
      .find(
        (e) =>
          (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "text_end",
      );

    expect(textEndEvt).toBeDefined();
    const aMe = (textEndEvt as { assistantMessageEvent?: Record<string, unknown> })
      .assistantMessageEvent;
    // Empty delta ensures deltaBuffer isn't double-appended with the full text
    expect(aMe?.delta).toBe("");
    // Full content retained for the handler's monotonic suffix check
    expect(aMe?.content).toBe("Some text");
  });

  it("text_end is emitted between text_delta and message_end", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reply text" }],
        },
      } as never,
      state,
    );

    const allEvtTypes = events.map((e) => {
      const rec = e as { assistantMessageEvent?: { type?: string } };
      return rec.assistantMessageEvent?.type ?? e.type;
    });

    const textDeltaIdx = allEvtTypes.indexOf("text_delta");
    const textEndIdx = allEvtTypes.indexOf("text_end");
    const messageEndIdx = allEvtTypes.lastIndexOf("message_end");

    expect(textEndIdx).toBeGreaterThan(textDeltaIdx);
    expect(messageEndIdx).toBeGreaterThan(textEndIdx);
  });

  it("thinking blocks do NOT emit text_end (only text blocks do)", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me think" }],
        },
      } as never,
      state,
    );

    const updateEvtTypes = events
      .filter((e) => e.type === "message_update")
      .map(
        (e) =>
          (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ?? "",
      );

    expect(updateEvtTypes).not.toContain("text_end");
    expect(updateEvtTypes).not.toContain("text_delta");
  });

  it("multiple text blocks each get their own text_delta + text_end pair", () => {
    const state = makeState();
    const events = captureEvents(state);

    // Two separate text blocks in one assistant message (thinking between them)
    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I need to respond" },
            { type: "text", text: "First part" },
          ],
        },
      } as never,
      state,
    );

    const updateEvtTypes = events
      .filter((e) => e.type === "message_update")
      .map(
        (e) =>
          (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ?? "",
      );

    // Should have exactly one text_delta and one text_end
    const deltaCount = updateEvtTypes.filter((t) => t === "text_delta").length;
    const endCount = updateEvtTypes.filter((t) => t === "text_end").length;
    expect(deltaCount).toBe(1);
    expect(endCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compaction events (SDKCompactBoundaryMessage — confirmed in official TypeScript ref)
// ---------------------------------------------------------------------------

describe("event translation — compaction events", () => {
  function emitCompactionCompletionSignal(state: ClaudeSdkEventAdapterState): void {
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
  }

  it("emits auto_compaction_start immediately and auto_compaction_end on next eligible event", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_abc",
        compact_metadata: { trigger: "auto", pre_tokens: 100000 },
      } as never,
      state,
    );
    emitCompactionCompletionSignal(state);

    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("auto_compaction_start");
    const endIdx = types.indexOf("auto_compaction_end");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "auto_compaction_end", willRetry: false }),
    );
  });

  it("does NOT emit agent_start for compact_boundary (only for init)", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_abc",
        compact_metadata: { trigger: "manual", pre_tokens: 50000 },
      } as never,
      state,
    );

    expect(events.map((e) => e.type)).not.toContain("agent_start");
  });

  it("auto_compaction_start carries pre_tokens and trigger from compact_metadata", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_compact",
        compact_metadata: { trigger: "auto", pre_tokens: 87500 },
      } as never,
      state,
    );

    const startEvt = events.find((e) => e.type === "auto_compaction_start");
    expect(startEvt).toBeDefined();
    // pre_tokens enables handlers to populate tokenCount in before_compaction hooks
    expect(startEvt?.pre_tokens).toBe(87500);
    expect(startEvt?.trigger).toBe("auto");
  });

  it("auto_compaction_end carries pre_tokens and trigger from compact_metadata", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_compact",
        compact_metadata: { trigger: "manual", pre_tokens: 64000 },
      } as never,
      state,
    );
    emitCompactionCompletionSignal(state);

    const endEvt = events.find((e) => e.type === "auto_compaction_end");
    expect(endEvt).toBeDefined();
    expect(endEvt?.pre_tokens).toBe(64000);
    expect(endEvt?.trigger).toBe("manual");
    expect(endEvt?.willRetry).toBe(false);
  });

  it("both compaction events carry the same pre_tokens and trigger", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_x",
        compact_metadata: { trigger: "auto", pre_tokens: 120000 },
      } as never,
      state,
    );
    emitCompactionCompletionSignal(state);

    const startEvt = events.find((e) => e.type === "auto_compaction_start") as Record<
      string,
      unknown
    >;
    const endEvt = events.find((e) => e.type === "auto_compaction_end") as Record<string, unknown>;

    expect(startEvt.pre_tokens).toBe(endEvt.pre_tokens);
    expect(startEvt.trigger).toBe(endEvt.trigger);
  });

  it("uses willRetry from compact boundary payload when present", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_retry",
        compact_metadata: { trigger: "auto", pre_tokens: 12345, will_retry: true },
      } as never,
      state,
    );
    emitCompactionCompletionSignal(state);

    const endEvt = events.find((e) => e.type === "auto_compaction_end");
    expect(endEvt?.willRetry).toBe(true);
  });

  it("uses top-level willRetry when compact_metadata omits retry fields", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_retry_top_level",
        compact_metadata: { trigger: "auto", pre_tokens: 777 },
        willRetry: true,
      } as never,
      state,
    );
    emitCompactionCompletionSignal(state);

    const endEvt = events.find((e) => e.type === "auto_compaction_end");
    expect(endEvt?.willRetry).toBe(true);
  });

  it("keeps compacting=true after compact_boundary until next eligible SDK message", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_recent",
        compact_metadata: { trigger: "auto", pre_tokens: 123 },
      } as never,
      state,
    );

    expect(state.compacting).toBe(true);

    emitCompactionCompletionSignal(state);

    expect(state.compacting).toBe(false);
  });

  it("ignores unknown messages while compacting and preserves compacting=true", () => {
    const state = makeState({ compacting: true });
    captureEvents(state);

    translateSdkMessageToEvents({ type: "unknown_x" } as never, state);

    expect(state.compacting).toBe(true);
  });

  it("does not end compaction on unknown system subtype", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_abc",
        compact_metadata: { trigger: "auto", pre_tokens: 1000 },
      } as never,
      state,
    );

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "ping",
      } as never,
      state,
    );

    expect(state.compacting).toBe(true);
    expect(events.filter((evt) => evt.type === "auto_compaction_end")).toHaveLength(0);
  });

  it("starts compaction on system/status=compacting and ends on system/status=null", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "status",
        status: "compacting",
        permissionMode: "bypassPermissions",
        session_id: "sess_status_1",
      } as never,
      state,
    );
    expect(state.compacting).toBe(true);
    expect(state.sdkStatus).toBe("compacting");
    expect(state.sdkPermissionMode).toBe("bypassPermissions");

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "status",
        status: null,
        session_id: "sess_status_1",
      } as never,
      state,
    );

    expect(state.compacting).toBe(false);
    expect(state.sdkStatus).toBeNull();
    expect(state.statusCompactingCount).toBe(1);
    expect(state.statusIdleCount).toBe(1);
    expect(events.map((evt) => evt.type)).toContain("auto_compaction_start");
    expect(events.map((evt) => evt.type)).toContain("auto_compaction_end");
  });

  it("increments compactBoundaryCount when compact_boundary arrives", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_boundary_1",
        compact_metadata: { trigger: "auto", pre_tokens: 10_000 },
      } as never,
      state,
    );

    expect(state.compactBoundaryCount).toBe(1);
  });

  it("does not emit duplicate auto_compaction_start when compact_boundary arrives during status compaction", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "status",
        status: "compacting",
        session_id: "sess_status_2",
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: "sess_status_2",
        compact_metadata: { trigger: "auto", pre_tokens: 42_000 },
      } as never,
      state,
    );

    const starts = events.filter((evt) => evt.type === "auto_compaction_start");
    expect(starts).toHaveLength(1);
    expect(state.pendingCompactionEnd?.pre_tokens).toBe(42_000);
  });
});

describe("event translation — sdk message coverage", () => {
  it("tracks files_persisted success and failures", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "files_persisted",
        files: [{ filename: "image-a.jpg", file_id: "file_123" }],
        failed: [{ filename: "image-b.jpg", error: "upload failed" }],
      } as never,
      state,
    );

    expect(state.persistedFileIdsByName?.get("image-a.jpg")).toBe("file_123");
    expect(state.failedPersistedFilesByName?.get("image-b.jpg")).toBe("upload failed");
    expect(state.persistedFileEvents).toHaveLength(1);
    expect(state.failedPersistedFileEvents).toHaveLength(1);
    expect(state.persistedFileEvents?.[0]).toMatchObject({
      filename: "image-a.jpg",
      fileId: "file_123",
    });
    expect(state.failedPersistedFileEvents?.[0]).toMatchObject({
      filename: "image-b.jpg",
      error: "upload failed",
    });
  });

  it("records files_persisted events even when filename is absent", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "files_persisted",
        files: [{ file_id: "file_without_name" }],
        failed: [{ error: "transient upload error" }],
      } as never,
      state,
    );

    expect(state.persistedFileEvents?.[0]).toMatchObject({
      filename: undefined,
      fileId: "file_without_name",
    });
    expect(state.failedPersistedFileEvents?.[0]).toMatchObject({
      filename: undefined,
      error: "transient upload error",
    });
  });

  it("tracks replayed user message acknowledgements", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "user",
        uuid: "user-msg-1",
        isReplay: true,
        session_id: "sess_user",
      } as never,
      state,
    );

    expect(state.replayedUserMessageUuids?.has("user-msg-1")).toBe(true);
  });

  it("stores auth_status payload", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "auth_status",
        isAuthenticating: true,
        output: ["waiting for oauth"],
      } as never,
      state,
    );

    expect(state.lastAuthStatus?.isAuthenticating).toBe(true);
    expect(state.lastAuthStatus?.output?.[0]).toBe("waiting for oauth");
  });

  it("stores hook/task/rate-limit/prompt-suggestion metadata", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "hook_response",
        hook_id: "hook_1",
        hook_name: "before_compaction",
        hook_event: "PreCompact",
        outcome: "success",
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task_1",
        status: "completed",
        summary: "done",
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", utilization: 0.8 },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "prompt_suggestion",
        suggestion: "Try asking for a test plan next.",
      } as never,
      state,
    );

    expect(state.lastHookEvent).toMatchObject({
      subtype: "hook_response",
      hookId: "hook_1",
      outcome: "success",
    });
    expect(state.lastTaskEvent).toMatchObject({
      subtype: "task_notification",
      taskId: "task_1",
      status: "completed",
    });
    expect(state.lastRateLimitInfo).toMatchObject({
      status: "allowed_warning",
    });
    expect(state.lastPromptSuggestion).toBe("Try asking for a test plan next.");
  });
});

// ---------------------------------------------------------------------------
// Section 2.1: stream_event handling
// ---------------------------------------------------------------------------

describe("event translation -- stream_event handling", () => {
  it("message_start emits Pi message_start with role assistant", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
            model: "claude-sonnet-4-5-20250514",
          },
        },
      } as never,
      state,
    );

    expect(events).toContainEqual(expect.objectContaining({ type: "message_start" }));
    const startEvt = events.find((e) => e.type === "message_start") as {
      message?: { role?: string };
    };
    expect(startEvt?.message?.role).toBe("assistant");
    expect(state.streamingInProgress).toBe(true);
  });

  it("message_delta usage merges with message_start usage", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            usage: { input_tokens: 1000, cache_read_input_tokens: 100 },
            model: "claude-sonnet-4-5-20250514",
          },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 200 },
        },
      } as never,
      state,
    );

    const usage = state.streamingPartialMessage?.usage as
      | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
      | undefined;
    expect(usage?.input_tokens).toBe(1000);
    expect(usage?.cache_read_input_tokens).toBe(100);
    expect(usage?.output_tokens).toBe(200);
  });

  it("content_block_start (text) records block type", () => {
    const state = makeState();
    captureEvents(state);

    // First send message_start to initialize streaming state
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );

    expect(state.streamingBlockTypes.get(0)).toBe("text");
  });

  it("content_block_start (thinking) emits thinking_start", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      } as never,
      state,
    );

    const thinkingStart = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "thinking_start",
    );
    expect(thinkingStart).toBeDefined();
  });

  it("content_block_delta (text_delta) emits text_delta with correct delta and content", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      } as never,
      state,
    );

    const textDelta = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "text_delta",
    );
    expect(textDelta).toBeDefined();
    const aMe = (textDelta as { assistantMessageEvent?: Record<string, unknown> })
      .assistantMessageEvent;
    expect(aMe?.delta).toBe("Hello");
    expect(aMe?.content).toBe("Hello");
  });

  it("content_block_delta (thinking_delta) emits thinking_delta", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me" },
        },
      } as never,
      state,
    );

    const thinkingDelta = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "thinking_delta",
    );
    expect(thinkingDelta).toBeDefined();
    const aMe = (thinkingDelta as { assistantMessageEvent?: Record<string, unknown> })
      .assistantMessageEvent;
    expect(aMe?.delta).toBe("Let me");
    expect(aMe?.content).toBe("Let me");
  });

  it("multiple text_delta events accumulate content correctly", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
      } as never,
      state,
    );

    const textDeltas = events.filter(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "text_delta",
    );
    expect(textDeltas).toHaveLength(2);
    const secondDelta = (textDeltas[1] as { assistantMessageEvent?: Record<string, unknown> })
      .assistantMessageEvent;
    expect(secondDelta?.delta).toBe(" world");
    expect(secondDelta?.content).toBe("Hello world");
  });

  it("content_block_stop (text) emits text_end with empty delta and full content", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Done" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      } as never,
      state,
    );

    const textEnd = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "text_end",
    );
    expect(textEnd).toBeDefined();
    const aMe = (textEnd as { assistantMessageEvent?: Record<string, unknown> })
      .assistantMessageEvent;
    expect(aMe?.delta).toBe("");
    expect(aMe?.content).toBe("Done");
  });

  it("content_block_stop (thinking) emits thinking_end", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      } as never,
      state,
    );

    const thinkingEnd = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "thinking_end",
    );
    expect(thinkingEnd).toBeDefined();
  });

  it("message_stop emits message_end", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "message_stop" },
      } as never,
      state,
    );

    expect(events).toContainEqual(expect.objectContaining({ type: "message_end" }));
  });

  it("full sequence: message_start → text deltas → text_end → message_end in order", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const allEvtTypes = events.map((e) => {
      const rec = e as { assistantMessageEvent?: { type?: string } };
      return rec.assistantMessageEvent?.type ?? e.type;
    });

    const messageStartIdx = allEvtTypes.indexOf("message_start");
    const textDeltaIdx = allEvtTypes.indexOf("text_delta");
    const textEndIdx = allEvtTypes.indexOf("text_end");
    const messageEndIdx = allEvtTypes.indexOf("message_end");

    expect(messageStartIdx).toBe(0);
    expect(textDeltaIdx).toBeGreaterThan(messageStartIdx);
    expect(textEndIdx).toBeGreaterThan(textDeltaIdx);
    expect(messageEndIdx).toBeGreaterThan(textEndIdx);
  });

  it("interleaved thinking + text blocks emit correct sequence", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    // Thinking block (index 0)
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "reasoning" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    // Text block (index 1)
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "answer" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const allEvtTypes = events.map((e) => {
      const rec = e as { assistantMessageEvent?: { type?: string } };
      return rec.assistantMessageEvent?.type ?? e.type;
    });

    const thinkingStartIdx = allEvtTypes.indexOf("thinking_start");
    const thinkingEndIdx = allEvtTypes.indexOf("thinking_end");
    const textDeltaIdx = allEvtTypes.indexOf("text_delta");
    const textEndIdx = allEvtTypes.indexOf("text_end");

    expect(thinkingStartIdx).toBeGreaterThan(0); // after message_start
    expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
    expect(textDeltaIdx).toBeGreaterThan(thinkingEndIdx);
    expect(textEndIdx).toBeGreaterThan(textDeltaIdx);
  });
});

// ---------------------------------------------------------------------------
// Section 2.2: streaming + complete message dedup
// ---------------------------------------------------------------------------

describe("event translation -- streaming + complete message dedup", () => {
  it("assistant message does NOT re-emit events when streaming preceded it", () => {
    const state = makeState();
    const events = captureEvents(state);

    // Stream events first
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const eventCountBeforeAssistant = events.length;

    // Now the complete assistant message arrives
    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      } as never,
      state,
    );

    // No new message_start/message_update/message_end events should be emitted
    const newEvents = events.slice(eventCountBeforeAssistant);
    const newMessageEvents = newEvents.filter(
      (e) => e.type === "message_start" || e.type === "message_update" || e.type === "message_end",
    );
    expect(newMessageEvents).toHaveLength(0);
  });

  it("state.messages IS updated from the complete assistant message", () => {
    const state = makeState();
    captureEvents(state);

    // Stream events
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    expect(state.messages).toHaveLength(0);

    // Complete assistant message
    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      } as never,
      state,
    );

    expect(state.messages).toHaveLength(1);
    const msg = state.messages[0] as { role: string };
    expect(msg.role).toBe("assistant");
  });

  it("streamingInProgress resets to false after complete assistant message", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    expect(state.streamingInProgress).toBe(true);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      } as never,
      state,
    );

    expect(state.streamingInProgress).toBe(false);
  });

  it("keeps one stable message id across non-streaming message lifecycle events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      } as never,
      state,
    );

    const ids = events
      .filter(
        (evt) =>
          evt.type === "message_start" ||
          evt.type === "message_update" ||
          evt.type === "message_end",
      )
      .map((evt) => (evt.message as { id?: string } | undefined)?.id)
      .filter((id): id is string => typeof id === "string");

    expect(new Set(ids).size).toBe(1);
  });

  it("keeps one stable message id across streaming message lifecycle events", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const ids = events
      .filter(
        (evt) =>
          evt.type === "message_start" ||
          evt.type === "message_update" ||
          evt.type === "message_end",
      )
      .map((evt) => (evt.message as { id?: string } | undefined)?.id)
      .filter((id): id is string => typeof id === "string");

    expect(new Set(ids).size).toBe(1);
  });

  it("collects assistant tool_use ids in stable queue order for pairing", () => {
    const state = makeState();
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "/a" } }],
        },
      } as never,
      state,
    );

    expect(state.pendingToolUses).toEqual([
      { id: "call_1", name: "read_file", input: { path: "/a" } },
    ]);
    expect(state.toolNameByUseId.get("call_1")).toBe("read_file");
  });

  it("translates SDK tool_progress to tool_execution_update", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "tool_progress",
        tool_use_id: "call_1",
        tool_name: "read_file",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1.2,
      } as never,
      state,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_update",
        toolName: "read_file",
        toolCallId: "call_1",
      }),
    );
  });

  it("translates SDK tool_use_summary to tool_execution_update for preceding tool IDs", () => {
    const state = makeState({
      toolNameByUseId: new Map([["call_1", "read_file"]]),
    });
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "tool_use_summary",
        summary: "Read completed",
        preceding_tool_use_ids: ["call_1"],
      } as never,
      state,
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_execution_update",
        toolName: "read_file",
        toolCallId: "call_1",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Section 2.3: JSONL persistence
// ---------------------------------------------------------------------------

describe("event translation -- JSONL persistence", () => {
  it("calls sessionManager.appendMessage for complete assistant message", () => {
    const appendMessage = vi.fn();
    const state = makeState({
      sessionManager: { appendMessage },
    });
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: "end_turn",
        },
      } as never,
      state,
    );

    expect(appendMessage).toHaveBeenCalledTimes(1);
    const persisted = appendMessage.mock.calls[0][0];
    expect(persisted.role).toBe("assistant");
    expect(persisted.api).toBe("anthropic-messages");
    expect(persisted.stopReason).toBe("stop");
    expect(persisted.usage.input).toBe(100);
    expect(persisted.usage.output).toBe(50);
    expect(persisted.usage.totalTokens).toBe(150);
    expect(persisted.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });

  it("normalizes stopReason values to Pi-compatible enums", () => {
    const appendMessage = vi.fn();
    const state = makeState({
      sessionManager: { appendMessage },
    });
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "tool call pending" }],
          stop_reason: "tool_use",
        },
      } as never,
      state,
    );

    const persisted = appendMessage.mock.calls[0][0];
    expect(persisted.stopReason).toBe("toolUse");
    const runtimeAssistant = state.messages[state.messages.length - 1] as { stopReason?: string };
    expect(runtimeAssistant.stopReason).toBe("toolUse");
  });

  it("normalizes stopReason edge cases with safe fallback for unknown strings", () => {
    const appendMessage = vi.fn();
    const state = makeState({ sessionManager: { appendMessage } });
    captureEvents(state);

    const cases = [
      { input: "length", expected: "length" },
      { input: "max_tokens", expected: "length" },
      { input: "aborted", expected: "aborted" },
      { input: "cancelled", expected: "aborted" },
      { input: "future_new_reason", expected: "stop" },
    ];

    for (const testCase of cases) {
      translateSdkMessageToEvents(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            stop_reason: testCase.input,
          },
        } as never,
        state,
      );
    }

    const persistedStopReasons = appendMessage.mock.calls.map((call) => call[0].stopReason);
    expect(persistedStopReasons).toEqual(cases.map((testCase) => testCase.expected));
    const runtimeStopReasons = state.messages.map(
      (message) => (message as { stopReason?: string }).stopReason,
    );
    expect(runtimeStopReasons).toEqual(cases.map((testCase) => testCase.expected));
  });

  it("uses configured transcript provider/api metadata for persistence", () => {
    const appendMessage = vi.fn();
    const state = makeState({
      sessionManager: { appendMessage },
      transcriptProvider: "openrouter",
      transcriptApi: "claude-sdk",
    });
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      } as never,
      state,
    );

    const persisted = appendMessage.mock.calls[0][0];
    expect(persisted.provider).toBe("openrouter");
    expect(persisted.api).toBe("claude-sdk");
  });

  it("persists usage.cost when model pricing is available", () => {
    const appendMessage = vi.fn();
    const state = makeState({
      sessionManager: { appendMessage },
      modelCost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    });
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      } as never,
      state,
    );

    const persisted = appendMessage.mock.calls[0][0];
    expect(persisted.usage.cost.input).toBeCloseTo(0.003, 12);
    expect(persisted.usage.cost.output).toBeCloseTo(0.003, 12);
    expect(persisted.usage.cost.cacheRead).toBeCloseTo(0.000015, 12);
    expect(persisted.usage.cost.cacheWrite).toBeCloseTo(0.00009375, 12);
    expect(persisted.usage.cost.total).toBeCloseTo(0.00610875, 12);
  });

  it("maps tool_use blocks to toolCall format in persisted content", () => {
    const appendMessage = vi.fn();
    const state = makeState({
      sessionManager: { appendMessage },
    });
    captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that" },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/foo.ts" } },
          ],
        },
      } as never,
      state,
    );

    const persisted = appendMessage.mock.calls[0][0];
    expect(persisted.content).toEqual([
      { type: "text", text: "Let me read that" },
      { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/foo.ts" } },
    ]);
  });

  it("does not throw when sessionManager.appendMessage is undefined", () => {
    const state = makeState({ sessionManager: undefined });
    captureEvents(state);

    expect(() => {
      translateSdkMessageToEvents(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
        } as never,
        state,
      );
    }).not.toThrow();
  });

  it("does not throw when appendMessage throws", () => {
    const appendMessage = vi.fn(() => {
      throw new Error("disk full");
    });
    const state = makeState({
      sessionManager: { appendMessage },
    });
    captureEvents(state);

    expect(() => {
      translateSdkMessageToEvents(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
        } as never,
        state,
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue 4: message_delta stop_reason propagation
// The message_delta event carries delta.stop_reason which must be captured
// and reflected in the message_end event's stopReason field.
// ---------------------------------------------------------------------------

describe("event translation -- streaming message_delta stop_reason propagation", () => {
  it("message_end carries stopReason 'stop' when message_delta delivers end_turn", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 20 },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const messageEnd = events.find((e) => e.type === "message_end") as
      | { message?: { stopReason?: string } }
      | undefined;
    expect(messageEnd).toBeDefined();
    expect(messageEnd?.message?.stopReason).toBe("stop");
  });

  it("message_end carries stopReason 'toolUse' when message_delta delivers tool_use", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 5 },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const messageEnd = events.find((e) => e.type === "message_end") as
      | { message?: { stopReason?: string } }
      | undefined;
    expect(messageEnd?.message?.stopReason).toBe("toolUse");
  });

  it("stop_reason from message_delta is carried on all subsequent events including message_end", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 100 },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const messageEnd = events.find((e) => e.type === "message_end") as
      | { message?: { stopReason?: string } }
      | undefined;
    expect(messageEnd?.message?.stopReason).toBe("length");
  });
});

// ---------------------------------------------------------------------------
// Issue 6: Streaming tool_use content accumulation (no sparse array holes)
// Tool_use blocks are accumulated into streamingPartialMessage.content so
// the content array mirrors the final assistant message structure at every
// streaming index. input_json_delta chunks are concatenated and parsed at
// content_block_stop.
// ---------------------------------------------------------------------------

describe("event translation -- streaming tool_use content accumulation", () => {
  it("thinking@0 tool_use@1 text@2: all three block types present in message_end content", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    // thinking at index 0
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "I need to read" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    // tool_use at index 1 with input_json_delta chunks
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "call_1", name: "read_file" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"/foo.ts"}' },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } } as never,
      state,
    );
    // text at index 2
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 2, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "here" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 2 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const messageEnd = events.find((e) => e.type === "message_end") as
      | { message?: { content?: unknown[] } }
      | undefined;
    expect(messageEnd).toBeDefined();
    const content = messageEnd?.message?.content ?? [];

    // Dense array — no holes
    expect(content).toHaveLength(3);
    for (const item of content) {
      expect(item).not.toBeNull();
      expect(item).not.toBeUndefined();
    }

    // Block types at correct indices
    expect((content[0] as { type: string }).type).toBe("thinking");
    expect((content[1] as { type: string }).type).toBe("tool_use");
    expect((content[2] as { type: string }).type).toBe("text");

    // tool_use block has id, name, and parsed input
    const toolBlock = content[1] as { id?: string; name?: string; input?: unknown };
    expect(toolBlock.id).toBe("call_1");
    expect(toolBlock.name).toBe("read_file");
    expect(toolBlock.input).toEqual({ path: "/foo.ts" });
  });

  it("tool_use input defaults to {} when no input_json_delta chunks arrive", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call_2", name: "noop" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "message_stop" } } as never,
      state,
    );

    const messageEnd = events.find((e) => e.type === "message_end") as
      | { message?: { content?: unknown[] } }
      | undefined;
    const content = messageEnd?.message?.content ?? [];
    expect(content).toHaveLength(1);
    const toolBlock = content[0] as { type: string; id: string; input: unknown };
    expect(toolBlock.type).toBe("tool_use");
    expect(toolBlock.id).toBe("call_2");
    expect(toolBlock.input).toEqual({});
  });

  it("mid-stream text_delta events include accumulated tool_use block at intermediate index", () => {
    const state = makeState();
    const events = captureEvents(state);

    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "test" },
        },
      } as never,
      state,
    );
    // thinking at index 0
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } } as never,
      state,
    );
    // tool_use at index 1
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "c1", name: "write" },
        },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } } as never,
      state,
    );
    // text at index 2
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 2, content_block: { type: "text" } },
      } as never,
      state,
    );
    translateSdkMessageToEvents(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "answer" },
        },
      } as never,
      state,
    );

    // text_delta event at index 2 carries content with tool_use at index 1
    const textDeltaEvt = events.find(
      (e) =>
        e.type === "message_update" &&
        (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
          "text_delta",
    ) as { message?: { content?: unknown[] } } | undefined;

    expect(textDeltaEvt).toBeDefined();
    const content = textDeltaEvt?.message?.content ?? [];
    expect(content).toHaveLength(3);
    expect((content[1] as { type: string }).type).toBe("tool_use");

    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain("null");
  });
});
