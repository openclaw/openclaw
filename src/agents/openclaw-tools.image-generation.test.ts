import { describe, expect, it } from "vitest";
import { collectPresentOpenClawTools } from "./openclaw-tools.registration.js";
import { textResult, type AnyAgentTool } from "./tools/common.js";

function stubAgentTool(name: string): AnyAgentTool {
  return {
    label: name,
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult("ok", {});
    },
  };
}

describe("openclaw tools image generation registration", () => {
  it("registers image_generate when an image-generation tool is present", () => {
    const imageGenerateTool = stubAgentTool("image_generate");

    expect(collectPresentOpenClawTools([imageGenerateTool])).toEqual([imageGenerateTool]);
  });

  it("omits image_generate when the image-generation tool is absent", () => {
    expect(collectPresentOpenClawTools([null]).map((tool) => tool.name)).not.toContain(
      "image_generate",
    );
  });
});
