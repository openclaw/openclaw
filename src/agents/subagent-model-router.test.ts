import { describe, expect, it } from "vitest";
import { classifySubagentModelRouterTask } from "./subagent-model-router.js";

describe("classifySubagentModelRouterTask", () => {
  it("classifies Hebrew operational tasks with the shared model-router task taxonomy", () => {
    expect(classifySubagentModelRouterTask("קאבינט נפל עם שגיאה בלוגים")).toBe("coding");
    expect(classifySubagentModelRouterTask("מה דעתך, כדאי לפתוח rollout הדרגתי?")).toBe(
      "reasoning",
    );
    expect(classifySubagentModelRouterTask("תסכם לי את הדוח הזה לבן")).toBe("writing");
    expect(classifySubagentModelRouterTask("כן")).toBe("trivial");
  });

  it("keeps visual and research routes distinct", () => {
    expect(classifySubagentModelRouterTask("analyze this screenshot and UI state")).toBe("visual");
    expect(classifySubagentModelRouterTask("research and compare model routing options")).toBe(
      "research",
    );
  });
});
