import { describe, expect, it } from "vitest";
import {
  appendInterleavedDelta,
  appendStatusLine,
  computeInterleavedSpill,
  emptyInterleavedStreamState,
  INTERLEAVED_LINE_MAX_CHARS,
  INTERLEAVED_MESSAGE_MAX_CHARS,
  INTERLEAVED_SPILL_OVERLAP_CHARS,
  renderInterleavedMessage,
  resolveInterleavedProgressEnabled,
  resolveInterleavedToolLine,
  sanitizeInterleavedLine,
  stripFinalAnswerFromInterleavedBody,
  stripReasoningHeader,
} from "./interleaved-progress.js";

describe("resolveInterleavedToolLine", () => {
  const sanitized = "🛠️ Bash: ls -la";

  it("shows the tool name only by default (args never appear unless opted in)", () => {
    expect(
      resolveInterleavedToolLine({ showArgs: false, sanitizedLine: sanitized, toolName: "Bash" }),
    ).toBe("tool: Bash");
  });

  it("shows the sanitized args/detail line when opted in", () => {
    expect(
      resolveInterleavedToolLine({ showArgs: true, sanitizedLine: sanitized, toolName: "Bash" }),
    ).toBe(sanitized);
  });

  it("falls back to name-only when opted in but no detail line was produced", () => {
    expect(
      resolveInterleavedToolLine({ showArgs: true, sanitizedLine: undefined, toolName: "Bash" }),
    ).toBe("tool: Bash");
  });

  it("uses a generic label when the tool name is missing", () => {
    expect(
      resolveInterleavedToolLine({
        showArgs: false,
        sanitizedLine: undefined,
        toolName: undefined,
      }),
    ).toBe("tool running");
  });
});

describe("resolveInterleavedProgressEnabled", () => {
  const base = { toolProgressEnabled: true, configEnabled: true, hasReasoningLane: true };

  it("enables only when opted in, tool progress on, and a reasoning lane exists", () => {
    expect(resolveInterleavedProgressEnabled(base)).toBe(true);
  });
  it("is disabled by default (config flag unset)", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, configEnabled: undefined })).toBe(false);
  });

  it("is disabled when explicitly opted out", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, configEnabled: false })).toBe(false);
  });
  it("is disabled when preview tool progress is off", () => {
    expect(resolveInterleavedProgressEnabled({ ...base, toolProgressEnabled: false })).toBe(false);
  });
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
  it("renders a single 'Thinking' header", () => {
    const out = renderInterleavedMessage({ body: "_thought_" });
    expect(out).toBe("Thinking\n\n_thought_");
    expect(out.match(/Thinking/gu)?.length).toBe(1);
  });

  it("appends a rolling-timer suffix while a tool is running", () => {
    const out = renderInterleavedMessage({ body: "_body_", timerStartedAt: 1_000, now: 13_000 });
    expect(out).toMatch(/^Thinking\n\n_body_\n_12s — still running · \d{2}:\d{2}:\d{2}_$/u);
  });
  it("renders empty for an empty body with no active timer", () => {
    expect(renderInterleavedMessage({ body: "" })).toBe("");
    expect(renderInterleavedMessage({ body: "   \n  " })).toBe("");
  });
  it("still renders when a timer is active even if the body is empty", () => {
    expect(renderInterleavedMessage({ body: "", timerStartedAt: 1_000, now: 4_000 })).toMatch(
      /^Thinking\n\n\n_3s — still running · \d{2}:\d{2}:\d{2}_$/u,
    );
  });
  it("drops the timer suffix when no timer is active, yielding a shorter prefix", () => {
    const withTimer = renderInterleavedMessage({
      body: "_body_",
      timerStartedAt: 1_000,
      now: 9_000,
    });
    const withoutTimer = renderInterleavedMessage({ body: "_body_" });
    expect(withoutTimer.length).toBeLessThan(withTimer.length);
    expect(withTimer.startsWith(withoutTimer)).toBe(true);
  });
});

describe("appendInterleavedDelta", () => {
  it("appends only the new suffix for cumulative-snapshot producers", () => {
    const first = appendInterleavedDelta({
      body: "",
      state: emptyInterleavedStreamState(),
      text: "step one",
    });
    expect(first.body).toBe("step one");
    const second = appendInterleavedDelta({
      body: first.body,
      state: first.state,
      text: "step one step two",
    });
    expect(second.body).toBe("step one step two");
    expect(second.state.previousText).toBe("step one step two");
  });
  it("appends the suffix after a tool line, chronologically, without re-stamping", () => {
    const first = appendInterleavedDelta({
      body: "",
      state: emptyInterleavedStreamState(),
      text: "reading files",
    });
    const bodyWithTool = `${first.body}\n[12:00:01] tool: Read\n`;
    const second = appendInterleavedDelta({
      body: bodyWithTool,
      state: first.state,
      text: "reading files and summarizing",
    });
    expect(second.body).toBe("reading files\n[12:00:01] tool: Read\n and summarizing");
    expect(second.body.match(/reading files/gu)?.length).toBe(1);
  });

  it("appends an explicit delta verbatim", () => {
    const first = appendInterleavedDelta({
      body: "",
      state: emptyInterleavedStreamState(),
      text: "Hello",
      delta: "Hello",
    });
    const second = appendInterleavedDelta({
      body: first.body,
      state: first.state,
      text: "Hello world",
      delta: " world",
    });
    expect(second.body).toBe("Hello world");
  });

  it("on replace, strips the last increment and appends the replacement (Working… -> Done.)", () => {
    const first = appendInterleavedDelta({
      body: "",
      state: emptyInterleavedStreamState(),
      text: "Working…",
    });
    expect(first.body).toBe("Working…");
    const second = appendInterleavedDelta({
      body: first.body,
      state: first.state,
      text: "Done.",
      replace: true,
    });
    expect(second.body).toBe("Done.");
  });
  it("replaces a non-prefix reasoning snapshot rather than leaving the stale one", () => {
    const first = appendInterleavedDelta({
      body: "",
      state: emptyInterleavedStreamState(),
      text: "Considering option A in depth.",
    });
    expect(first.body).toBe("Considering option A in depth.");
    const second = appendInterleavedDelta({
      body: first.body,
      state: first.state,
      text: "Actually option B is the move.",
      replace: true,
    });
    expect(second.body).toBe("Actually option B is the move.");
    expect(second.body).not.toContain("option A");
  });

  it("appends a fresh non-prefix fragment whole (delta producers without a delta field)", () => {
    const first = appendInterleavedDelta({
      body: "",
      state: emptyInterleavedStreamState(),
      text: "alpha",
    });
    const second = appendInterleavedDelta({ body: first.body, state: first.state, text: "beta" });
    expect(second.body).toBe("alphabeta");
  });

  it("is a no-op when an identical cumulative snapshot is re-delivered", () => {
    const state = { previousText: "step one", lastIncrement: "step one" };
    const out = appendInterleavedDelta({ body: "step one", state, text: "step one" });
    expect(out.body).toBe("step one");
  });
  it("never duplicates a fragment across a long growing cumulative stream", () => {
    const snapshots = [
      "Comparing the build to what I pushed:",
      "Comparing the build to what I pushed: that's 255 tests,",
      "Comparing the build to what I pushed: that's 255 tests, up from the 252 I saw before + my 3 dedup",
      "Comparing the build to what I pushed: that's 255 tests, up from the 252 I saw before + my 3 dedup tests.",
    ];
    let body = "";
    let state = emptyInterleavedStreamState();
    for (const text of snapshots) {
      const out = appendInterleavedDelta({ body, state, text });
      body = out.body;
      state = out.state;
    }
    expect(body).toBe(snapshots[snapshots.length - 1]);
    expect(body.match(/252 I saw before \+ my 3 dedup/gu)?.length).toBe(1);
  });
  it("dedups identical content arriving via two separate streams into one body", () => {
    const sentence =
      "Local HEAD 61f4536 differs from last time I checked (87d3da4). Let me see what changed.";
    let body = "";
    let reasoning = emptyInterleavedStreamState();
    let assistant = emptyInterleavedStreamState();
    let r = appendInterleavedDelta({
      body,
      state: reasoning,
      text: "Local HEAD 61f4536 differs from last time I ",
    });
    body = r.body;
    reasoning = r.state;
    const a = appendInterleavedDelta({
      body,
      state: assistant,
      text: "HEAD 61f4536 differs from last time I checked (87d3da4). Let me see what changed.",
    });
    body = a.body;
    assistant = a.state;
    r = appendInterleavedDelta({ body, state: reasoning, text: sentence });
    body = r.body;
    reasoning = r.state;

    expect(body).toBe(sentence);
    expect(body.match(/61f4536/gu)?.length).toBe(1);
  });
  it("folds a short full-increment duplicate from a second stream", () => {
    let body = "";
    const r = appendInterleavedDelta({
      body,
      state: emptyInterleavedStreamState(),
      text: "There",
    });
    body = r.body;
    expect(body).toBe("There");
    const a = appendInterleavedDelta({
      body,
      state: emptyInterleavedStreamState(),
      text: "There it is.",
    });
    body = a.body;
    expect(body).toBe("There it is.");
    expect(body.match(/There/gu)?.length).toBe(1);
  });
  it("keeps distinct content from two streams (no false dedup)", () => {
    let body = "";
    const r = appendInterleavedDelta({
      body,
      state: emptyInterleavedStreamState(),
      text: "Considering the tradeoffs here.",
    });
    body = r.body;
    const a = appendInterleavedDelta({
      body,
      state: emptyInterleavedStreamState(),
      text: "Now checking the second file.",
    });
    body = a.body;
    expect(body).toBe("Considering the tradeoffs here.Now checking the second file.");
  });
  it("does not fold a sub-threshold coincidental tail/prefix overlap", () => {
    const result = appendInterleavedDelta({
      body: "alpha",
      state: emptyInterleavedStreamState(),
      text: "and beta",
    });
    expect(result.body).toBe("alphaand beta");
  });
  it("still folds a full-tail re-send below the partial threshold", () => {
    const result = appendInterleavedDelta({
      body: "OK",
      state: emptyInterleavedStreamState(),
      text: "OK so here is the plan",
    });
    expect(result.body).toBe("OK so here is the plan");
  });
});

describe("appendStatusLine", () => {
  it("appends a sanitized, timestamped line and never the raw args", () => {
    const out = appendStatusLine({ body: "", line: "tool: Bash", timestamp: "12:00:00" });
    expect(out.body).toBe("\n[12:00:00] tool: Bash\n");
    expect(out.appendedLine).toBe("tool: Bash");
  });

  it("returns the body unchanged for an empty/whitespace line", () => {
    const out = appendStatusLine({ body: "x", line: "   ", timestamp: "12:00:00" });
    expect(out.body).toBe("x");
    expect(out.appendedLine).toBeUndefined();
  });

  it("deduplicates consecutive identical lines (start+update phases)", () => {
    const first = appendStatusLine({ body: "", line: "tool: Bash", timestamp: "12:00:01" });
    expect(first.appendedLine).toBe("tool: Bash");
    const second = appendStatusLine({
      body: first.body,
      line: "tool: Bash",
      timestamp: "12:00:02",
      previousLine: first.appendedLine,
    });
    expect(second.body).toBe(first.body);
    expect(second.appendedLine).toBeUndefined();
  });

  it("appends when the line differs from previousLine", () => {
    const first = appendStatusLine({ body: "", line: "tool: Bash", timestamp: "12:00:01" });
    const second = appendStatusLine({
      body: first.body,
      line: "tool: Read",
      timestamp: "12:00:02",
      previousLine: first.appendedLine,
    });
    expect(second.body).toContain("tool: Read");
    expect(second.appendedLine).toBe("tool: Read");
  });
});

describe("stripFinalAnswerFromInterleavedBody", () => {
  it("strips a trailing final-answer block that leaked into the lane", () => {
    const body = "_thinking_\n[12:00:01] tool: Read\nHere is the summary of all three files.";
    expect(
      stripFinalAnswerFromInterleavedBody({
        body,
        finalText: "Here is the summary of all three files.",
      }),
    ).toBe("_thinking_\n[12:00:01] tool: Read");
  });

  it("matches despite whitespace/markdown differences between stream and canonical text", () => {
    const body = "_thinking_\n[12:00:01] tool: Read\nHere   is\nthe summary.";
    expect(stripFinalAnswerFromInterleavedBody({ body, finalText: "Here is the summary." })).toBe(
      "_thinking_\n[12:00:01] tool: Read",
    );
  });

  it("leaves the body unchanged when there is no confident tail match", () => {
    const body = "_thinking_\n[12:00:01] tool: Read\nintermediate commentary";
    expect(
      stripFinalAnswerFromInterleavedBody({ body, finalText: "a completely different answer" }),
    ).toBe(body);
  });

  it("never strips across a tool/status checkpoint", () => {
    const body = "shared text\n[12:00:01] tool: Read\nother tail";
    expect(stripFinalAnswerFromInterleavedBody({ body, finalText: "shared text" })).toBe(body);
  });

  it("is a no-op for empty final text", () => {
    const body = "_thinking_\nsome commentary";
    expect(stripFinalAnswerFromInterleavedBody({ body, finalText: "" })).toBe(body);
  });
});

describe("computeInterleavedSpill", () => {
  it("does not spill while the visible body fits within one message", () => {
    const body = "x".repeat(INTERLEAVED_MESSAGE_MAX_CHARS - 10);
    expect(computeInterleavedSpill({ body, offset: 0 })).toEqual({ offset: 0, spilled: false });
  });

  it("spills into a continuation, advancing the offset and carrying recent context", () => {
    const line = `${"y".repeat(99)}\n`;
    const body = line.repeat(60);
    const result = computeInterleavedSpill({ body, offset: 0 });
    expect(result.spilled).toBe(true);
    expect(result.offset).toBeGreaterThan(0);
    expect(body.length - result.offset).toBeLessThanOrEqual(INTERLEAVED_MESSAGE_MAX_CHARS);
    expect(body.length - result.offset).toBeGreaterThan(300);
    expect(body.length - result.offset).toBeLessThanOrEqual(INTERLEAVED_SPILL_OVERLAP_CHARS);
    expect(result.offset === 0 || body[result.offset - 1] === "\n").toBe(true);
  });

  it("repeated spills keep every continuation under the cap as the body grows", () => {
    const line = `${"z".repeat(120)}\n`;
    let body = "";
    let offset = 0;
    for (let i = 0; i < 200; i += 1) {
      body += line;
      const result = computeInterleavedSpill({ body, offset });
      offset = result.offset;
      expect(body.length - offset).toBeLessThanOrEqual(INTERLEAVED_MESSAGE_MAX_CHARS);
    }
    expect(offset).toBeGreaterThan(0);
  });

  it("force-advances when a single line is longer than the overlap window", () => {
    const body = "q".repeat(INTERLEAVED_MESSAGE_MAX_CHARS + 2000);
    const result = computeInterleavedSpill({ body, offset: 0 });
    expect(result.spilled).toBe(true);
    expect(body.length - result.offset).toBeLessThanOrEqual(INTERLEAVED_MESSAGE_MAX_CHARS);
  });
});

describe("renderInterleavedMessage length cap", () => {
  it("never exceeds maxChars even for an oversized body (tail-capped with marker)", () => {
    const body = "a".repeat(10_000);
    const rendered = renderInterleavedMessage({
      body,
      maxChars: INTERLEAVED_MESSAGE_MAX_CHARS,
      timerStartedAt: 1_000,
      now: 4_000,
    });
    expect(rendered.length).toBeLessThanOrEqual(INTERLEAVED_MESSAGE_MAX_CHARS);
    expect(rendered.startsWith("Thinking\n\n")).toBe(true);
    expect(rendered).toContain("…");
    expect(rendered).toMatch(/3s — still running · \d{2}:\d{2}:\d{2}_$/u);
  });

  it("leaves a within-budget body untouched (no marker, no truncation)", () => {
    const rendered = renderInterleavedMessage({
      body: "short body",
      maxChars: INTERLEAVED_MESSAGE_MAX_CHARS,
    });
    expect(rendered).toBe("Thinking\n\nshort body");
  });
});
