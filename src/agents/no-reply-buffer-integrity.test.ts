/**
 * Fork regression test: NO_REPLY streaming buffer integrity.
 *
 * Root cause: When the model streams NO_REPLY as fragmented tokens ("NO" + "_REPLY"),
 * handleMessageUpdate's parseReplyDirectives strips the complete silent token and
 * sets shouldEmit=false. The server-chat buffer retains only "NO" from the first
 * delta, causing chatFinal to leak "NO" to Eyrie.
 *
 * Fix: When cumulative text becomes a recognized silent token, emit an assistant
 * event with the full raw text to update the buffer, plus a signoff event for
 * the watchdog.
 *
 * This test uses the real embedded subscribe pipeline via the e2e harness.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, afterEach } from "vitest";
import { onAgentEvent, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("NO_REPLY streaming buffer fix", () => {
  const RUN_ID = "test-noreply-buffer";

  afterEach(() => {
    resetAgentRunContextForTest();
  });

  it("emits assistant event with full NO_REPLY when cumulative text becomes silent token", () => {
    const { session, emit } = createStubSessionHarness();
    const agentEvents: any[] = [];
    const unsub = onAgentEvent((evt) => {
      if (evt.runId === RUN_ID) {
        agentEvents.push({ stream: evt.stream, data: evt.data });
      }
    });

    subscribeEmbeddedPiSession({
      session,
      runId: RUN_ID,
    });

    // Stream "NO" as first delta
    emitAssistantTextDelta({ emit, delta: "NO" });

    // Stream "_REPLY" as second delta
    emitAssistantTextDelta({ emit, delta: "_REPLY" });

    // Check: we should see an assistant event with text "NO_REPLY"
    // to update the buffer from "NO" to "NO_REPLY"
    const assistantEvents = agentEvents.filter((e) => e.stream === "assistant");
    const lastAssistant = assistantEvents[assistantEvents.length - 1];
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant.data.text).toBe("NO_REPLY");

    // Check: signoff event should have fired
    const signoffEvents = agentEvents.filter((e) => e.stream === "signoff");
    expect(signoffEvents.length).toBe(1);
    expect(signoffEvents[0].data.token).toBe("NO_REPLY");

    unsub();
  });

  it("HEARTBEAT_OK streams normally (not stripped by parseReplyDirectives)", () => {
    const { session, emit } = createStubSessionHarness();
    const agentEvents: any[] = [];
    const unsub = onAgentEvent((evt) => {
      if (evt.runId === RUN_ID) {
        agentEvents.push({ stream: evt.stream, data: evt.data });
      }
    });

    subscribeEmbeddedPiSession({
      session,
      runId: RUN_ID,
    });

    emitAssistantTextDelta({ emit, delta: "HEARTBEAT" });
    emitAssistantTextDelta({ emit, delta: "_OK" });

    // HEARTBEAT_OK is NOT stripped by parseReplyDirectives (which only knows NO_REPLY).
    // It flows as normal assistant text. Suppression happens later in emitChatFinal
    // via normalizeHeartbeatChatFinalText. So the buffer gets the full token naturally.
    const assistantEvents = agentEvents.filter((e) => e.stream === "assistant");
    const lastAssistant = assistantEvents[assistantEvents.length - 1];
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant.data.text).toBe("HEARTBEAT_OK");

    // No signoff event needed — HEARTBEAT_OK is handled by different suppression path
    unsub();
  });

  it("does NOT emit extra events for normal non-silent text", () => {
    const { session, emit } = createStubSessionHarness();
    const agentEvents: any[] = [];
    const unsub = onAgentEvent((evt) => {
      if (evt.runId === RUN_ID) {
        agentEvents.push({ stream: evt.stream, data: evt.data });
      }
    });

    subscribeEmbeddedPiSession({
      session,
      runId: RUN_ID,
    });

    emitAssistantTextDelta({ emit, delta: "Hello " });
    emitAssistantTextDelta({ emit, delta: "world" });

    const signoffEvents = agentEvents.filter((e) => e.stream === "signoff");
    expect(signoffEvents.length).toBe(0);

    const assistantEvents = agentEvents.filter((e) => e.stream === "assistant");
    // All assistant events should have real text, never empty
    for (const evt of assistantEvents) {
      expect(evt.data.text.trim().length).toBeGreaterThan(0);
    }

    unsub();
  });

  it("single-token NO_REPLY also produces assistant + signoff events", () => {
    const { session, emit } = createStubSessionHarness();
    const agentEvents: any[] = [];
    const unsub = onAgentEvent((evt) => {
      if (evt.runId === RUN_ID) {
        agentEvents.push({ stream: evt.stream, data: evt.data });
      }
    });

    subscribeEmbeddedPiSession({
      session,
      runId: RUN_ID,
    });

    // Model outputs NO_REPLY as a single token
    emitAssistantTextDelta({ emit, delta: "NO_REPLY" });

    const signoffEvents = agentEvents.filter((e) => e.stream === "signoff");
    expect(signoffEvents.length).toBe(1);

    unsub();
  });
});
