import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { captureAgent, makeCall } from "../../packages/agent-core/src/agent-loop.test-support.js";
import { TOOL_REPEAT_LIMIT_CODE } from "../../packages/agent-core/src/tool-repeat-guard.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

describe("Code Mode stable tool rotations", () => {
  afterEach(resetCodeModeTestState);

  it.each(["stable", "progress", "prepared", "throws", "throws-progress", "schema"] as const)(
    "observes completed nested tools through the real executor: %s",
    async (kind) => {
      const harness = createCodeModeHarness({ codeMode: { executor: "node" } });
      const executed: string[] = [];
      const names = ["inspect_alpha", "inspect_beta", "inspect_gamma"];
      const hidden = names.map((name) =>
        pluginToolWithExecute(name, name, async () => {
          executed.push(name);
          if (kind === "throws" || kind === "throws-progress") {
            throw new Error(
              `Cannot inspect ${name}${kind === "throws-progress" ? `: ${executed.length}` : ""}`,
            );
          }
          return jsonResult({ value: kind === "progress" ? executed.length : name });
        }),
      );
      if (kind === "schema") {
        for (const tool of hidden) {
          tool.outputSchema = Type.Object({ value: Type.String() });
        }
      }
      if (kind === "prepared") {
        let prepared = 0;
        for (const tool of hidden) {
          tool.prepareBeforeToolCallParams = async () => ({ value: `${prepared++}` });
        }
      }
      applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, ...hidden] });
      const { agent } = captureAgent(harness.tools, {}, [
        ...Array.from({ length: 20 }, (_, index) => [
          {
            ...makeCall("exec", `cell-${index}`),
            // The wrapper varies while the actual catalog requests remain identical.
            arguments: {
              title: "Inspect resources",
              code: `/* cell ${index} */ return await Promise.all(
                [inspect_alpha({}), inspect_beta({}), inspect_gamma({})]
                  .map(call => call.catch(error => ({ error: String(error) })))
              );`,
            },
          },
        ]),
        [{ type: "text", text: "done" }],
      ]);

      await agent.prompt("Inspect all three resources until finished.");

      const shouldStop = kind === "stable" || kind === "throws" || kind === "schema";
      expect(executed, JSON.stringify(agent.state.messages.slice(-3))).toHaveLength(
        shouldStop ? 30 : 60,
      );
      if (shouldStop) {
        const results = JSON.stringify(agent.state.messages.filter((m) => m.role === "toolResult"));
        expect(results).toContain(TOOL_REPEAT_LIMIT_CODE);
        expect(results).not.toContain("declared outputSchema");
      }
      expect(agent.state.messages.at(-1)).toMatchObject(
        shouldStop
          ? {
              role: "assistant",
              stopReason: "error",
              errorCode: TOOL_REPEAT_LIMIT_CODE,
            }
          : { role: "assistant", stopReason: "stop" },
      );
    },
  );
});
