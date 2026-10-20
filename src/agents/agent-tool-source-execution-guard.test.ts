import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { runWithToolExecutionValidation } from "./agent-tools.execution-validation.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

it("caps parallel admissions and cancels queued effects when the budget is exhausted", async () => {
  const controller = new AbortController();
  const budget = createAgentToolExecutionBudget({
    maxToolCalls: 2,
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
  });
  const source = vi.fn(async () => ({ content: [], details: {} }));
  await budget.run(async () => {
    const tool = wrapToolWithBeforeToolCallHook({ ...createStubTool("read"), execute: source });
    const outcomes = await Promise.allSettled([1, 2, 3].map((id) => tool.execute(String(id), {})));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
  });

  expect(source).not.toHaveBeenCalled();
  expect(budget.toolCalls).toBe(2);
  expect(controller.signal.reason).toEqual(new Error("Agent tool-call budget exhausted"));
});

it("charges rejected arguments before allowing another tool attempt", async () => {
  const controller = new AbortController();
  const budget = createAgentToolExecutionBudget({
    maxToolCalls: 8,
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
  });
  const source = vi.fn(async () => ({ content: [], details: {} }));
  let rejected = 0;
  await budget.run(async () => {
    const tool = wrapToolWithBeforeToolCallHook({
      ...createStubTool("skill_workshop"),
      parameters: Type.Object({ action: Type.Literal("view") }),
      execute: source,
    });
    for (let i = 0; i < 8; i++) {
      await expect(
        runWithToolExecutionValidation(
          String(i),
          (value) => {
            const validation = validateJsonSchemaValue({ schema: tool.parameters, value });
            if (!validation.ok) {
              rejected++;
              throw new Error('Invalid action "update"');
            }
          },
          () => tool.execute(String(i), { action: "update" }),
        ),
      ).rejects.toThrow('Invalid action "update"');
    }
    await expect(tool.execute("ninth", { action: "view" })).rejects.toThrow(
      "Agent tool-call budget exhausted",
    );
  });
  expect(rejected).toBe(8);
  expect(source).not.toHaveBeenCalled();
  expect(budget.toolCalls).toBe(8);
});
