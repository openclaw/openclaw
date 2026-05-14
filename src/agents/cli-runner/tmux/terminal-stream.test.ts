import { describe, expect, it } from "vitest";
import {
  normalizeTerminalAssistantText,
  stripTerminalControls,
  TerminalDeltaTracker,
} from "./terminal-stream.js";

describe("terminal-stream", () => {
  it("strips ANSI control sequences", () => {
    expect(stripTerminalControls("\u001B[31mhello\u001B[0m\r\n")).toBe("hello\n");
  });

  it("drops common Claude UI chrome lines", () => {
    expect(normalizeTerminalAssistantText("╭── box\nhello\n✻ cooking\n")).toBe("hello");
  });

  it("emits deltas for growing terminal snapshots", () => {
    const tracker = new TerminalDeltaTracker();
    expect(tracker.push("hello")).toBe("hello");
    expect(tracker.push("hello world")).toBe(" world");
    expect(tracker.getText()).toBe("hello world");
  });
});
