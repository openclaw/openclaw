import { describe, expect, it } from "vitest";
import { buildTraceToolSummary } from "./run-attempt-result.js";

describe("tool result summary", () => {
  it.each([false, true])(
    "keeps failure counts independent of same-tool recovery (%s)",
    (recovered) => {
      const successfulTool = recovered ? "bash" : "read";

      expect(
        buildTraceToolSummary({
          toolMetas: [
            { toolName: "bash", isError: true },
            { toolName: "bash", isError: true },
            { toolName: successfulTool, isError: false },
          ],
          lastToolError: recovered
            ? undefined
            : { toolName: "bash", error: "private tool failure details" },
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
