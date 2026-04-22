import { describe, expect, it } from "vitest";
import { createStubTool } from "../../test-helpers/pi-tool-stubs.js";
import { resolveEmbeddedAgentSessionToolOptions } from "./attempt-session.js";

describe("resolveEmbeddedAgentSessionToolOptions", () => {
  it("keeps the session allowlist populated when tool implementations live in customTools", () => {
    const { tools, customTools } = resolveEmbeddedAgentSessionToolOptions({
      tools: [createStubTool("read"), createStubTool("write")],
      clientTools: [
        {
          type: "function",
          function: {
            name: "image_generate",
            description: "Generate an image",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      sandboxEnabled: false,
    });

    expect(tools).toEqual(["image_generate", "read", "write"]);
    expect(customTools.map((tool) => tool.name)).toEqual(["read", "write"]);
  });
});
