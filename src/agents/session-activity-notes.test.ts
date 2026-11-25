import { beforeEach, describe, expect, it } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  createSessionActivityNoteState,
  flushSessionActivityAssistantNote,
  noteSessionActivityEvent,
} from "./session-activity-notes.js";

let state: ReturnType<typeof createSessionActivityNoteState>;
beforeEach(() => {
  state = createSessionActivityNoteState();
});

function note(stream: AgentEventPayload["stream"], data: AgentEventPayload["data"], ts = 1_000) {
  noteSessionActivityEvent(state, { runId: "run-1", seq: ts, stream, ts, data });
}
function assistant(ts: number, text: string, delta: string) {
  note("assistant", { text, delta }, ts);
}

describe("session activity assistant buffering", () => {
  it("preserves split internal-context filtering when the forced flush follows a burst", () => {
    assistant(1_000, "visible\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n", "visible");
    assistant(
      1_050,
      "visible\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nafter",
      "secret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nafter",
    );

    flushSessionActivityAssistantNote(state);

    expect(state.notes.at(-1)?.text).toBe("Assistant: visible after");
  });

  it("records prepared literal NO_REPLY as assistant activity", () => {
    assistant(1_000, "NO_REPLY", "NO_REPLY");
    flushSessionActivityAssistantNote(state);
    expect(state.notes.at(-1)?.text).toBe("Assistant: NO_REPLY");
  });

  it("keeps delta-only producers on the bounded incremental path", () => {
    assistant(1_000, "", "a".repeat(5_000));
    assistant(1_001, "", "tail");

    expect(state.assistantBuffer).toHaveLength(4_096);
    expect(state.assistantBuffer.endsWith("tail")).toBe(true);
    expect(state.assistantBufferDirty).toBe(false);
  });

  it("releases cumulative text after retaining its bounded activity tail", () => {
    const text = `${"a".repeat(64 * 1024)}😀\ud800tail`;
    assistant(1_000, text, "");
    flushSessionActivityAssistantNote(state);

    expect(
      Object.values(state)
        .filter((value) => typeof value === "string")
        .every((value) => value.length <= 4_096),
    ).toBe(true);
    expect(state.notes.at(-1)?.text).toBe(`Assistant: ${"a".repeat(233)}😀\ud800tail`);

    assistant(1_001, "", " continued");
    flushSessionActivityAssistantNote(state);
    expect(state.notes.at(-1)?.text).toBe(`Assistant: ${"a".repeat(223)}😀\ud800tail continued`);
  });

  it("does not report a signal-only aborted lifecycle end as done", () => {
    note("lifecycle", { phase: "end", aborted: true });

    expect(state.notes.at(-1)?.text).toBe("Run failed");
  });

  it("records the normalized terminal reply as the final assistant activity fact", () => {
    const terminalReply = { disposition: "visible", text: "Final answer from the run." };
    note("lifecycle", {
      phase: "end",
      terminalReply,
    });

    expect(state.notes.at(-1)?.text).toBe("Assistant: Final answer from the run.");
    expect(state.terminalReply).toEqual(terminalReply);
  });
});
