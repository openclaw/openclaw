import { describe, expect, it } from "vitest";
import { __testing } from "./run-attempt.js";

describe("Codex dynamic tool filtering", () => {
  it("drops the image tool when the model already has inbound vision input", () => {
    const toolNames = __testing
      .filterToolsForVisionInputs(
        [{ name: "image" }, { name: "read" }, { name: "write" }],
        {
          modelHasVision: true,
          hasInboundImages: true,
        },
      )
      .map((tool) => tool.name);

    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("image");
  });
});
