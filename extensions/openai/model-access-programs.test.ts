import { expect, it } from "vitest";
import { buildOpenAICodexReadyOutcome } from "./model-service-tiers.js";

it("retains only explicit authenticated program metadata and distinguishes empty from missing", () => {
  const result = buildOpenAICodexReadyOutcome([
    {
      slug: "blue",
      available_access_programs: { cyber: ["standard", "daybreak_blue", "future_program"] },
    },
    { slug: "none", available_access_programs: { cyber: [] } },
    { slug: "unknown" },
    { slug: "invalid", available_access_programs: { cyber: [12] } },
  ]);
  expect(
    result.modelAccessPrograms?.map(({ modelId, runtimeId, cyber }) => ({
      modelId,
      runtimeId,
      cyber,
    })),
  ).toEqual([
    { modelId: "blue", runtimeId: "openclaw", cyber: ["standard", "daybreak_blue"] },
    { modelId: "blue", runtimeId: "codex", cyber: ["standard", "daybreak_blue"] },
    { modelId: "none", runtimeId: "openclaw", cyber: [] },
    { modelId: "none", runtimeId: "codex", cyber: [] },
  ]);
});
