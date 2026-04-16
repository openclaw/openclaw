import { describe, expect, it } from "vitest";
import { formatPlanForHydration } from "./plan-hydration.js";

describe("formatPlanForHydration", () => {
  it("returns null for empty steps", () => {
    expect(formatPlanForHydration([])).toBeNull();
  });

  it("returns null for all-completed steps", () => {
    const steps = [
      { step: "Install deps", status: "completed" },
      { step: "Run tests", status: "completed" },
    ];
    expect(formatPlanForHydration(steps)).toBeNull();
  });

  it("returns null for all-cancelled steps", () => {
    const steps = [
      { step: "Install deps", status: "cancelled" },
      { step: "Run tests", status: "cancelled" },
    ];
    expect(formatPlanForHydration(steps)).toBeNull();
  });

  it("returns null for mix of completed and cancelled steps", () => {
    const steps = [
      { step: "Install deps", status: "completed" },
      { step: "Run tests", status: "cancelled" },
      { step: "Deploy", status: "completed" },
    ];
    expect(formatPlanForHydration(steps)).toBeNull();
  });

  it("filters out completed and cancelled steps", () => {
    const steps = [
      { step: "Install deps", status: "completed" },
      { step: "Run tests", status: "cancelled" },
      { step: "Fix lint", status: "in_progress" },
      { step: "Deploy", status: "pending" },
    ];
    const result = formatPlanForHydration(steps);
    expect(result).not.toBeNull();
    expect(result).not.toContain("Install deps");
    expect(result).not.toContain("Run tests");
    expect(result).toContain("Fix lint");
    expect(result).toContain("Deploy");
  });

  it("includes pending and in_progress steps with correct markers", () => {
    const steps = [
      { step: "Investigate bug", status: "in_progress" },
      { step: "Write fix", status: "pending" },
      { step: "Add tests", status: "pending" },
    ];
    const result = formatPlanForHydration(steps)!;
    expect(result).toContain("[>] Investigate bug (in_progress)");
    expect(result).toContain("[ ] Write fix (pending)");
    expect(result).toContain("[ ] Add tests (pending)");
  });

  it("output format starts with preserved plan header", () => {
    const steps = [
      { step: "Do something", status: "pending" },
    ];
    const result = formatPlanForHydration(steps)!;
    expect(result).toMatch(
      /^\[Your active plan was preserved across context compression\]/,
    );
  });
});
