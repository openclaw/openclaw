import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { ExecutionHealthMonitor } from "./execution-health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolUseMessage(
  tools: Array<{ name: string; input: unknown; id?: string }>,
): AgentMessage {
  return {
    role: "assistant",
    content: tools.map((t, i) => ({
      type: "tool_use" as const,
      id: t.id ?? `tool_${i}`,
      name: t.name,
      input: t.input,
    })),
  };
}

function makeToolResultMessage(
  results: Array<{ tool_use_id: string; content?: string; is_error?: boolean }>,
): AgentMessage {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.tool_use_id,
      content: r.content ?? "ok",
      is_error: r.is_error ?? false,
    })),
  };
}

/** Build a session with N file write turns (assistant tool_use + user tool_result). */
function buildFileWriteSession(count: number, _prePrompt = 2): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "user", content: "system prompt" },
    { role: "assistant", content: "acknowledged" },
  ];
  for (let i = 0; i < count; i++) {
    const id = `write_${i}`;
    messages.push(
      makeToolUseMessage([
        { name: "Write", input: { file_path: `/tmp/plan-${i}.md`, content: "plan" }, id },
      ]),
    );
    messages.push(makeToolResultMessage([{ tool_use_id: id, content: "File written" }]));
  }
  return messages;
}

/** Build a session with N identical tool calls. */
function buildRepeatToolSession(count: number, toolName: string, input: unknown): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "user", content: "system prompt" },
    { role: "assistant", content: "acknowledged" },
  ];
  for (let i = 0; i < count; i++) {
    const id = `repeat_${i}`;
    messages.push(makeToolUseMessage([{ name: toolName, input, id }]));
    messages.push(makeToolResultMessage([{ tool_use_id: id, content: "done" }]));
  }
  return messages;
}

/** Build a session with N error tool results. */
function buildErrorSession(count: number): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: "user", content: "system prompt" },
    { role: "assistant", content: "acknowledged" },
  ];
  for (let i = 0; i < count; i++) {
    const id = `err_${i}`;
    messages.push(makeToolUseMessage([{ name: "Bash", input: { command: "failing-cmd" }, id }]));
    messages.push(
      makeToolResultMessage([{ tool_use_id: id, content: "command not found", is_error: true }]),
    );
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionHealthMonitor", () => {
  describe("disabled", () => {
    it("returns no signals when disabled", () => {
      const monitor = new ExecutionHealthMonitor({ enabled: false });
      const messages = buildFileWriteSession(20);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals).toHaveLength(0);
    });
  });

  describe("file-burst", () => {
    it("detects file burst above threshold", () => {
      const monitor = new ExecutionHealthMonitor({ fileBurstThreshold: 5 });
      const messages = buildFileWriteSession(6);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      const fb = signals.find((s) => s.type === "file-burst");
      expect(fb).toBeDefined();
      expect(fb!.severity).toBe("warning");
      expect(fb!.details.fileCreations).toBe(6);
    });

    it("does not trigger below threshold", () => {
      const monitor = new ExecutionHealthMonitor({ fileBurstThreshold: 10 });
      const messages = buildFileWriteSession(5);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "file-burst")).toBeUndefined();
    });

    it("marks critical at 3x threshold", () => {
      const monitor = new ExecutionHealthMonitor({ fileBurstThreshold: 5 });
      const messages = buildFileWriteSession(15);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      const fb = signals.find((s) => s.type === "file-burst");
      expect(fb).toBeDefined();
      expect(fb!.severity).toBe("critical");
    });

    it("exactly at threshold triggers warning", () => {
      const monitor = new ExecutionHealthMonitor({ fileBurstThreshold: 5 });
      const messages = buildFileWriteSession(5);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      const fb = signals.find((s) => s.type === "file-burst");
      expect(fb).toBeDefined();
      expect(fb!.severity).toBe("warning");
    });
  });

  describe("tool-repeat", () => {
    it("detects repeated tool calls with same args", () => {
      const monitor = new ExecutionHealthMonitor({ toolRepeatThreshold: 3 });
      const messages = buildRepeatToolSession(4, "Bash", { command: "echo hello" });
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      const tr = signals.find((s) => s.type === "tool-repeat");
      expect(tr).toBeDefined();
      expect(tr!.details.repeatedTools).toContain("Bash");
    });

    it("ignores Read tool repeats", () => {
      const monitor = new ExecutionHealthMonitor({ toolRepeatThreshold: 3 });
      const messages = buildRepeatToolSession(10, "Read", { file_path: "/tmp/foo.md" });
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "tool-repeat")).toBeUndefined();
    });

    it("does not trigger below threshold", () => {
      const monitor = new ExecutionHealthMonitor({ toolRepeatThreshold: 5 });
      const messages = buildRepeatToolSession(4, "Bash", { command: "echo hello" });
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "tool-repeat")).toBeUndefined();
    });
  });

  describe("no-effect-loop", () => {
    it("detects turns without real effects", () => {
      const monitor = new ExecutionHealthMonitor({ noEffectLoopThreshold: 3 });
      const messages: AgentMessage[] = [
        { role: "user", content: "system prompt" },
        { role: "assistant", content: "acknowledged" },
      ];

      // Simulate 3 turns without real effects (only file writes)
      for (let i = 0; i < 3; i++) {
        const id = `noop_${i}`;
        messages.push(
          makeToolUseMessage([
            { name: "Write", input: { file_path: `/tmp/plan-${i}.md`, content: "x" }, id },
          ]),
        );
        messages.push(makeToolResultMessage([{ tool_use_id: id, content: "ok" }]));
        const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
        if (i < 2) {
          expect(signals.find((s) => s.type === "no-effect-loop")).toBeUndefined();
        } else {
          const nel = signals.find((s) => s.type === "no-effect-loop");
          expect(nel).toBeDefined();
          expect(nel!.severity).toBe("warning");
        }
      }
    });

    it("resets streak on effect", () => {
      const monitor = new ExecutionHealthMonitor({ noEffectLoopThreshold: 3 });

      // Build a cumulative message array (simulating real session growth)
      const messages: AgentMessage[] = [
        { role: "user", content: "system prompt" },
        { role: "assistant", content: "acknowledged" },
      ];

      // Turn 1: no effect (file write)
      messages.push(
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/a.md", content: "x" }, id: "w1" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "w1", content: "ok" }]));
      monitor.evaluate({ messages, prePromptMessageCount: 2 });

      // Turn 2: no effect (file write)
      messages.push(
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/b.md", content: "x" }, id: "w2" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "w2", content: "ok" }]));
      monitor.evaluate({ messages, prePromptMessageCount: 2 });

      // Turn 3: effect (git push) — streak should reset, no trigger at threshold 3
      messages.push(
        makeToolUseMessage([
          { name: "Bash", input: { command: "git push origin main" }, id: "push_1" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "push_1", content: "pushed" }]));
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "no-effect-loop")).toBeUndefined();

      // Turn 4: no effect — streak is 1 after reset, should not trigger
      messages.push(
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/c.md", content: "x" }, id: "w3" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "w3", content: "ok" }]));
      const signals2 = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals2.find((s) => s.type === "no-effect-loop")).toBeUndefined();
    });
  });

  describe("error-cascade", () => {
    it("detects consecutive errors", () => {
      const monitor = new ExecutionHealthMonitor({ errorCascadeThreshold: 3 });
      const messages = buildErrorSession(3);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      const ec = signals.find((s) => s.type === "error-cascade");
      expect(ec).toBeDefined();
      expect(ec!.severity).toBe("warning");
    });

    it("does not trigger below threshold", () => {
      const monitor = new ExecutionHealthMonitor({ errorCascadeThreshold: 3 });
      const messages = buildErrorSession(2);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "error-cascade")).toBeUndefined();
    });

    it("marks critical at 2x threshold", () => {
      const monitor = new ExecutionHealthMonitor({ errorCascadeThreshold: 3 });
      const messages = buildErrorSession(6);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      const ec = signals.find((s) => s.type === "error-cascade");
      expect(ec).toBeDefined();
      expect(ec!.severity).toBe("critical");
    });

    it("stops counting on success", () => {
      const monitor = new ExecutionHealthMonitor({ errorCascadeThreshold: 3 });
      const messages: AgentMessage[] = [
        { role: "user", content: "system prompt" },
        { role: "assistant", content: "acknowledged" },
        // 2 errors, then a success, then 2 errors = no cascade
        ...buildErrorSession(2).slice(2),
        makeToolUseMessage([{ name: "Bash", input: { command: "echo ok" }, id: "ok_1" }]),
        makeToolResultMessage([{ tool_use_id: "ok_1", content: "ok" }]),
        ...buildErrorSession(2).slice(2),
      ];
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "error-cascade")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty session", () => {
      const monitor = new ExecutionHealthMonitor();
      const messages: AgentMessage[] = [
        { role: "user", content: "system prompt" },
        { role: "assistant", content: "acknowledged" },
      ];
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals).toHaveLength(0);
    });

    it("handles single turn", () => {
      const monitor = new ExecutionHealthMonitor();
      const messages: AgentMessage[] = [
        { role: "user", content: "system prompt" },
        { role: "assistant", content: "acknowledged" },
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/a.md", content: "x" }, id: "w1" },
        ]),
        makeToolResultMessage([{ tool_use_id: "w1", content: "ok" }]),
      ];
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      // 1 write is below default threshold of 10
      expect(signals.find((s) => s.type === "file-burst")).toBeUndefined();
    });

    it("respects config overrides", () => {
      const monitor = new ExecutionHealthMonitor({
        fileBurstThreshold: 2,
        errorCascadeThreshold: 1,
      });
      const messages = buildFileWriteSession(2);
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "file-burst")).toBeDefined();
    });

    it("reset clears internal state", () => {
      const monitor = new ExecutionHealthMonitor({ noEffectLoopThreshold: 2 });
      const messages: AgentMessage[] = [
        { role: "user", content: "system prompt" },
        { role: "assistant", content: "acknowledged" },
      ];

      // Turn 1: no effect
      messages.push(
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/a.md", content: "x" }, id: "r1" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "r1", content: "ok" }]));
      monitor.evaluate({ messages, prePromptMessageCount: 2 });

      // Turn 2: no effect — should trigger at threshold 2
      messages.push(
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/b.md", content: "x" }, id: "r2" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "r2", content: "ok" }]));
      const signals = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals.find((s) => s.type === "no-effect-loop")).toBeDefined();

      monitor.reset();

      // After reset, streak is 0 — turn 3 should NOT trigger
      messages.push(
        makeToolUseMessage([
          { name: "Write", input: { file_path: "/tmp/c.md", content: "x" }, id: "r3" },
        ]),
      );
      messages.push(makeToolResultMessage([{ tool_use_id: "r3", content: "ok" }]));
      const signals2 = monitor.evaluate({ messages, prePromptMessageCount: 2 });
      expect(signals2.find((s) => s.type === "no-effect-loop")).toBeUndefined();
    });
  });
});
