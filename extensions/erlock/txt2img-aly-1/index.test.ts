import { describe, expect, it } from "vitest";
import { createTxt2ImgAlyTool } from "./index.js";

describe("txt2img-aly-1 tool", () => {
  it("registers with expected tool name", () => {
    const tool = createTxt2ImgAlyTool();
    expect(tool.name).toBe("txt2img_aly");
  });

  it("returns error when model is unsupported", async () => {
    const tool = createTxt2ImgAlyTool();
    const result = await tool.execute("call-1", {
      model: "qwen-image-plus",
      input_: {
        messages: [{ role: "user", content: [{ text: "一只猫" }] }],
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text?: string }).text).toContain("qwen-image-max");
  });

  it("returns error when API key is missing", async () => {
    const tool = createTxt2ImgAlyTool();
    const current = process.env.OPENCLAW_ALY_API_KEY;
    delete process.env.OPENCLAW_ALY_API_KEY;

    const result = await tool.execute("call-2", {
      model: "qwen-image-max",
      input_: {
        messages: [{ role: "user", content: [{ text: "a misty forest" }] }],
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text?: string }).text).toContain("OPENCLAW_ALY_API_KEY");

    if (current) {
      process.env.OPENCLAW_ALY_API_KEY = current;
    }
  });

  it("accepts parameters passed as a JSON string", async () => {
    const tool = createTxt2ImgAlyTool();
    const result = await tool.execute("call-3", {
      model: "qwen-image-max",
      input_: {
        messages: [{ role: "user", content: [{ text: "a cat on a windowsill" }] }],
      },
      parameters: '{"size":"1328*1328","n":1}',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text?: string }).text).toContain("OPENCLAW_ALY_API_KEY");
  });
});
