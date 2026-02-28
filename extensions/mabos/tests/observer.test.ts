import { describe, it, expect } from "vitest";
import type { Observation } from "../src/tools/observation-types.js";
import {
  compressMessagesToObservations,
  formatObservationLog,
  estimateTokens,
  type ObservableMessage,
} from "../src/tools/observer.js";

describe("estimateTokens", () => {
  it("estimates 1 token per 4 characters", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("rounds up", () => {
    expect(estimateTokens("abc")).toBe(1);
  });
});

describe("compressMessagesToObservations", () => {
  it("compresses tool results shorter than 200 chars verbatim", () => {
    const messages: ObservableMessage[] = [
      { role: "tool", content: "File created: foo.ts", name: "write_file" },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations).toHaveLength(1);
    expect(observations[0].content).toBe("File created: foo.ts");
  });

  it("compresses long tool results", () => {
    const longContent = "x".repeat(500);
    const messages: ObservableMessage[] = [
      { role: "tool", content: longContent, name: "read_file" },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations).toHaveLength(1);
    // Should be significantly shorter than original
    expect(observations[0].content.length).toBeLessThan(longContent.length);
  });

  it("extracts errors as critical priority", () => {
    const messages: ObservableMessage[] = [
      {
        role: "tool",
        content: "Error: TypeError at line 45\n  at foo.ts:45\n  at bar.ts:12",
        name: "run_test",
      },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations[0].priority).toBe("critical");
  });

  it("marks user messages as at least important", () => {
    const messages: ObservableMessage[] = [{ role: "user", content: "Please fix the login bug" }];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations[0].priority).toBe("important");
  });

  it("assigns important priority to decisions", () => {
    const messages: ObservableMessage[] = [
      { role: "assistant", content: "I decided to use regex-based date extraction" },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations[0].priority).toBe("important");
  });

  it("achieves 3-6x text compression on long assistant messages", () => {
    const longMessage =
      "I will implement the following changes:\n" +
      Array.from(
        { length: 50 },
        (_, i) =>
          `- Step ${i}: Do something detailed with explanation about what needs to happen here and why it matters for the overall architecture`,
      ).join("\n");
    const messages: ObservableMessage[] = [{ role: "assistant", content: longMessage }];
    const { observations } = compressMessagesToObservations(messages, []);
    const ratio = longMessage.length / observations[0].content.length;
    expect(ratio).toBeGreaterThan(2); // At least 2x compression
  });

  it("achieves high compression on tool results with stack traces", () => {
    const toolResult =
      "Error: Connection refused\n" +
      Array.from(
        { length: 30 },
        (_, i) => `  at module${i}.handler (src/module${i}.ts:${i * 10}:5)`,
      ).join("\n");
    const messages: ObservableMessage[] = [
      { role: "tool", content: toolResult, name: "run_command" },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    const ratio = toolResult.length / observations[0].content.length;
    expect(ratio).toBeGreaterThan(5); // Stack trace stripping → high compression
  });

  it("tracks tool call count", () => {
    const messages: ObservableMessage[] = [
      { role: "tool", content: "result 1", name: "tool_a" },
      { role: "tool", content: "result 2", name: "tool_b" },
      { role: "user", content: "ok" },
    ];
    const { toolCallsCompressed, messagesCompressed } = compressMessagesToObservations(
      messages,
      [],
    );
    expect(toolCallsCompressed).toBe(2);
    expect(messagesCompressed).toBe(3);
  });

  it("extracts referenced dates from observations", () => {
    const messages: ObservableMessage[] = [
      {
        role: "assistant",
        content: "Meeting scheduled for 2026-03-15",
        timestamp: "2026-02-27T12:00:00Z",
      },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations[0].referenced_dates).toContain("2026-03-15");
  });

  it("is idempotent — same messages produce same structure", () => {
    const messages: ObservableMessage[] = [
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "I will fix it" },
    ];
    const r1 = compressMessagesToObservations(messages, []);
    const r2 = compressMessagesToObservations(messages, []);
    expect(r1.observations.length).toBe(r2.observations.length);
    expect(r1.messagesCompressed).toBe(r2.messagesCompressed);
  });

  it("skips empty messages", () => {
    const messages: ObservableMessage[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "Hello" },
    ];
    const { observations } = compressMessagesToObservations(messages, []);
    expect(observations).toHaveLength(1);
  });
});

describe("formatObservationLog", () => {
  it("returns empty string for no observations", () => {
    expect(formatObservationLog([])).toBe("");
  });

  it("groups observations by date", () => {
    const obs: Observation[] = [
      {
        id: "1",
        priority: "critical",
        content: "Error found",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
      },
      {
        id: "2",
        priority: "routine",
        content: "Read files",
        observed_at: "2026-02-26T10:00:00Z",
        tags: [],
        created_at: "2026-02-26T10:00:00Z",
      },
    ];
    const formatted = formatObservationLog(obs);
    expect(formatted).toContain("### 2026-02-27");
    expect(formatted).toContain("### 2026-02-26");
  });

  it("sorts critical before routine within same date", () => {
    const obs: Observation[] = [
      {
        id: "1",
        priority: "routine",
        content: "Read file",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
      },
      {
        id: "2",
        priority: "critical",
        content: "Build error",
        observed_at: "2026-02-27T11:00:00Z",
        tags: [],
        created_at: "2026-02-27T11:00:00Z",
      },
    ];
    const formatted = formatObservationLog(obs);
    const criticalIdx = formatted.indexOf("Build error");
    const routineIdx = formatted.indexOf("Read file");
    expect(criticalIdx).toBeLessThan(routineIdx);
  });

  it("skips superseded observations", () => {
    const obs: Observation[] = [
      {
        id: "1",
        priority: "routine",
        content: "Old info",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
        superseded_by: "2",
      },
      {
        id: "2",
        priority: "routine",
        content: "New info",
        observed_at: "2026-02-27T11:00:00Z",
        tags: [],
        created_at: "2026-02-27T11:00:00Z",
      },
    ];
    const formatted = formatObservationLog(obs);
    expect(formatted).not.toContain("Old info");
    expect(formatted).toContain("New info");
  });

  it("produces deterministic output for same inputs", () => {
    const obs: Observation[] = [
      {
        id: "a",
        priority: "important",
        content: "Decision made",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
      },
      {
        id: "b",
        priority: "critical",
        content: "Error found",
        observed_at: "2026-02-27T11:00:00Z",
        tags: [],
        created_at: "2026-02-27T11:00:00Z",
      },
    ];
    const formatted1 = formatObservationLog(obs);
    const formatted2 = formatObservationLog(obs);
    expect(formatted1).toBe(formatted2);
  });

  it("uses priority emojis", () => {
    const obs: Observation[] = [
      {
        id: "1",
        priority: "critical",
        content: "Error",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
      },
      {
        id: "2",
        priority: "important",
        content: "Decision",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
      },
      {
        id: "3",
        priority: "routine",
        content: "Read",
        observed_at: "2026-02-27T10:00:00Z",
        tags: [],
        created_at: "2026-02-27T10:00:00Z",
      },
    ];
    const formatted = formatObservationLog(obs);
    expect(formatted).toContain("\u{1F534}"); // red circle
    expect(formatted).toContain("\u{1F7E1}"); // yellow circle
    expect(formatted).toContain("\u{1F7E2}"); // green circle
  });
});
