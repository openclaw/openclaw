import { describe, expect, it } from "vitest";
import { createWorkflowTool } from "./workflow.js";

describe("automation workflow tool error format", () => {
  const api = {} as any;
  const tool = createWorkflowTool(api);

  it("returns fixed-format error when run misses workflowName", async () => {
    await expect(tool.execute("id", { action: "run" })).rejects.toThrow(
      "error_code=WORKFLOW_INPUT_INVALID",
    );
  });

  it("returns fixed-format error when workflow is unknown", async () => {
    await expect(tool.execute("id", { action: "run", workflowName: "not-exist" })).rejects.toThrow(
      "error_code=WORKFLOW_NOT_FOUND",
    );
  });

  it("returns fixed-format error for unknown action", async () => {
    await expect(tool.execute("id", { action: "oops" })).rejects.toThrow(
      "error_code=WORKFLOW_ACTION_UNKNOWN",
    );
  });
});
