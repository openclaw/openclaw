import { describe, expect, it } from "vitest";
import {
  appendReasoningBody,
  appendStatusLine,
  INTERLEAVED_LINE_MAX_CHARS,
  renderInterleavedMessage,
  resolveInterleavedProgressEnabled,
  resolveInterleavedToolLine,
  sanitizeInterleavedLine,
  stripReasoningHeader,
} from "./interleaved-progress.js";

describe("resolveInterleavedToolLine", () => {
  const sanitized = "🛠️ Bash: ls -la";

  it("shows the tool name only by default (args never appear unless opted in)", () => {
    expect(resolveInterleavedToolLine({ showArgs: false, sanitizedLine: sanitized, toolName: "Bash" })).toBe(
      "tool: Bash",
    );
  });

  it("shows the sanitized args/detail line when opted in", () => {
    expect(resolveInterleavedToolLine({ showArgs: true, sanitizedLine: sanitized, toolName: "Bash" })).toBe(
      sanitized,
    );
  });

  it("falls back to name-only when opted in but no detail line was produced", () => {
    expect(resolveInterleavedToolLine({ showArgs: true, sanitizedLine: undefined, toolName: "Bash" })).toBe(
      "tool: Bash",
    );
  });

  it("uses a generic label when the tool name is missing", () => {
    expect(resolveInterleavedToolLine({ showArgs: false, sanitizedLine: undefined, toolName: undefined })).toBe(
      "tool running",
    );
  });
});

describe("resolveInterleavedProgressEnabled", () => {
  const base = { toolProgressEnabled: true, configEnabled: true, hasReasoningLane: true };

  it("enables only when opted in, tool progress on, and a reasoning lane exists", () => {
    expect(resolveInterleavedProgressEnabled(base)).toBe(true);
  });

  // Disabled mode preserves current behaviour exactly: the gate is off, so the
  // renderer is inert and callers fall back to the default tool-progress lane.
  it("is disabled by default (config flag unset)", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, configEnabled: undefined })).toBe(false);
  });

  it("is disabled when explicitly opted out", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, configEnabled: false })).toBe(false);
  });

  // Tool-progress opt-out is honored: without preview tool progress the lane
  // never engages, so it inherits every existing group/DM/visibility gate.
  it("is disabled when preview tool progress is off", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, toolProgressEnabled: false })).toBe(false);
  });

  // Source-delivery-suppressed / room-event paths have no reasoning lane, so
  // the gate is off and no progress can leak through this renderer.
  it("is disabled when there is no reasoning lane (room-event / suppressed)", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, hasReasoningLane: false })).toBe(false);
  });
});

describe("sanitizeInterleavedLine", () => {
  it("collapses whitespace and trims", () => {
    expect(sanitizeInterleavedLine("  tool:   Bash\n\n  runs  ")).toBe("tool: Bash runs");
  });

  it("caps line length so a large/secret-looking value cannot flood the lane", () => {
    const long = `secret ${"x".repeat(500)}`;
    const out = sanitizeInterleavedLine(long);
    expect(out.length).toBe(INTERLEAVED_LINE_MAX_CHARS);
  });

  it("flattens multi-line content into a single line", () => {
    expect(sanitizeInterleavedLine("line1\nline2\nline3")).toBe("line1 line2 line3");
  });
});

describe("stripReasoningHeader", () => {
  it("removes the leading plain 'Thinking' header", () => {
    expect(stripReasoningHeader("Thinking\n\n_thought one_")).toBe("_thought one_");
  });

  it("leaves italic body lines (including a literal 'Thinking' word) untouched", () => {
    expect(stripReasoningHeader("Thinking\n\n_Thinking about it_")).toBe("_Thinking about it_");
  });

  it("is a no-op when there is no header", () => {
    expect(stripReasoningHeader("_already body_")).toBe("_already body_");
  });
});

describe("renderInterleavedMessage", () => {
  // Reasoning header is not duplicated: the body is stored header-stripped and
  // the renderer supplies exactly one "Thinking" header.
  it("renders a single 'Thinking' header", () => {
    const out = renderInterleavedMessage({ body: "_thought_" });
    expect(out).toBe("Thinking\n\n_thought_");
    expect(out.match(/Thinking/gu)?.length).toBe(1);
  });

  it("appends a rolling-timer suffix while a tool is running", () => {
    const out = renderInterleavedMessage({ body: "_body_", timerStartedAt: 1_000, now: 13_000 });
    expect(out).toBe("Thinking\n\n_body_\n_12s — still running_");
  });

  // Shorter replacement replaces instead of appending stale timer text: once the
  // timer is cleared the rendered text drops the suffix and is a strict prefix
  // of the timer-painted text, so a full-text lane update replaces it.
  it("drops the timer suffix when no timer is active, yielding a shorter prefix", () => {
    const withTimer = renderInterleavedMessage({ body: "_body_", timerStartedAt: 1_000, now: 9_000 });
    const withoutTimer = renderInterleavedMessage({ body: "_body_" });
    expect(withoutTimer.length).toBeLessThan(withTimer.length);
    expect(withTimer.startsWith(withoutTimer)).toBe(true);
  });
});

describe("appendReasoningBody", () => {
  it("appends only the new suffix for cumulative-snapshot producers", () => {
    const first = appendReasoningBody({
      body: "",
      previousBodyOnly: "",
      formattedReasoning: "Thinking\n\n_step one_",
    });
    expect(first.body).toBe("_step one_");
    expect(first.previousBodyOnly).toBe("_step one_");

    // Cumulative re-delivery of the same prefix plus new text must not duplicate.
    const second = appendReasoningBody({
      body: first.body,
      previousBodyOnly: first.previousBodyOnly,
      formattedReasoning: "Thinking\n\n_step one__step two_",
    });
    expect(second.body).toBe("_step one__step two_");
  });

  // Codex app-server sends onReasoningStream({ text: delta }); each chunk is a
  // fresh fragment, not a cumulative snapshot. A same-size/shorter later delta
  // must NOT vanish (the bug a length checkpoint caused).
  it("appends each fragment whole for delta producers", () => {
    const first = appendReasoningBody({
      body: "",
      previousBodyOnly: "",
      formattedReasoning: "Thinking\n\n_alpha_",
    });
    const second = appendReasoningBody({
      body: first.body,
      previousBodyOnly: first.previousBodyOnly,
      formattedReasoning: "Thinking\n\n_beta_",
    });
    expect(second.body).toBe("_alpha__beta_");

    // A shorter follow-up delta still survives.
    const third = appendReasoningBody({
      body: second.body,
      previousBodyOnly: second.previousBodyOnly,
      formattedReasoning: "Thinking\n\n_c_",
    });
    expect(third.body).toBe("_alpha__beta__c_");
  });

  it("is a no-op when an identical cumulative snapshot is re-delivered", () => {
    const out = appendReasoningBody({
      body: "_step one_",
      previousBodyOnly: "_step one_",
      formattedReasoning: "Thinking\n\n_step one_",
    });
    expect(out.body).toBe("_step one_");
    expect(out.previousBodyOnly).toBe("_step one_");
  });
});

describe("appendStatusLine", () => {
  it("appends a sanitized, timestamped line and never the raw args", () => {
    const out = appendStatusLine({ body: "", line: "tool: Bash", timestamp: "12:00:00" });
    expect(out).toBe("\n[12:00:00] tool: Bash\n");
  });

  it("returns the body unchanged for an empty/whitespace line", () => {
    expect(appendStatusLine({ body: "x", line: "   ", timestamp: "12:00:00" })).toBe("x");
  });
});
