import { afterEach, expect, it, vi } from "vitest";
import { resolveProgressCardTool } from "./openclaw-tools.progress-card.js";
import { shouldIncludeProgressCardToolForOpenClawTools } from "./openclaw-tools.registration.js";
import { createProgressCardTool } from "./tools/progress-card-tool.js";

vi.mock("./openclaw-tools.registration.js", () => ({
  shouldIncludeProgressCardToolForOpenClawTools: vi.fn(),
}));
vi.mock("./tools/progress-card-tool.js", () => ({ createProgressCardTool: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("forwards the caller plan-save hook only when the tool is admitted", () => {
  const onProgressCardPlanSaved = vi.fn();
  vi.mocked(shouldIncludeProgressCardToolForOpenClawTools).mockReturnValue(true);
  resolveProgressCardTool({ onProgressCardPlanSaved }, "main", "agent:main:main");
  expect(createProgressCardTool).toHaveBeenCalledExactlyOnceWith({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    onPlanSaved: onProgressCardPlanSaved,
  });
  vi.mocked(createProgressCardTool).mock.calls[0]?.[0]?.onPlanSaved?.(true);
  expect(onProgressCardPlanSaved).toHaveBeenCalledExactlyOnceWith(true);
  vi.mocked(shouldIncludeProgressCardToolForOpenClawTools).mockReturnValue(false);
  expect(
    resolveProgressCardTool({ onProgressCardPlanSaved }, "main", "agent:main:main"),
  ).toBeNull();
  expect(createProgressCardTool).toHaveBeenCalledOnce();
});
