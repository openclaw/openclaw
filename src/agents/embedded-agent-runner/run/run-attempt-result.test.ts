import { describe, expect, it } from "vitest";
import { createToolErrorState } from "../../tool-error-state.js";
import { buildTraceToolSummary } from "./run-attempt-result.js";

describe("tool result summary", () => {
  it.each([false, true])(
    "keeps failure counts independent of same-tool recovery (%s)",
    (recovered) => {
      const errors = createToolErrorState();
      errors.recordFailure({ toolName: "bash", error: "private tool failure details" });
      const successfulTool = recovered ? "bash" : "read";
      errors.recordSuccess(successfulTool);

      expect(
        buildTraceToolSummary({
          toolMetas: [
            { toolName: "bash", meta: "exit=1", isError: true },
            { toolName: "bash", meta: "exit=2", isError: true },
            { toolName: successfulTool, isError: false },
          ],
          lastToolError: errors.read().lastToolError,
        }),
      ).toEqual({
        calls: 3,
        tools: recovered ? ["bash"] : ["bash", "read"],
        failures: 2,
        ...(recovered ? {} : { unresolvedError: { toolName: "bash" } }),
      });
    },
  );
});
