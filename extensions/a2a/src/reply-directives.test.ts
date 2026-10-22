import { describe, expect, it } from "vitest";
import { A2A_TASK_STATES } from "./a2a-model.js";
import { extractInterruptDirective } from "./reply-directives.js";

describe("extractInterruptDirective", () => {
  it("parses a leading input-required directive and strips it from the reason", () => {
    const directive = extractInterruptDirective("[[input-required]] Which repo should I target?");
    expect(directive).toEqual({
      state: A2A_TASK_STATES.INPUT_REQUIRED,
      reason: "Which repo should I target?",
    });
  });

  it("parses auth-required and is case-insensitive", () => {
    const directive = extractInterruptDirective(" [[AUTH-REQUIRED]] Connect GitHub first.");
    expect(directive).toEqual({
      state: A2A_TASK_STATES.AUTH_REQUIRED,
      reason: "Connect GitHub first.",
    });
  });

  it("falls back to a default reason when the reply carries only the directive", () => {
    expect(extractInterruptDirective("[[input-required]]")?.reason).toBe(
      "Agent requires additional input to continue.",
    );
    expect(extractInterruptDirective("[[auth-required]]")?.reason).toBe(
      "Agent requires authorization to continue.",
    );
  });

  it("leaves ordinary replies (and mentions that are not leading) alone", () => {
    expect(extractInterruptDirective("All done.")).toBeUndefined();
    expect(extractInterruptDirective(undefined)).toBeUndefined();
    expect(extractInterruptDirective("I used [[input-required]] in prose")).toBeUndefined();
  });
});
