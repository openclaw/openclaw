import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImg2TxtAlyTool } from "./index.js";

describe("img2txt_aly", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns text from Aliyun response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: {
          choices: [
            {
              message: {
                content: [{ text: "图片中是一只坐在窗台上的猫。" }],
              },
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createImg2TxtAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-vl-max-latest",
      input_: {
        prompt: "请描述这张图片",
        image: "https://img.example/cat.png",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("猫");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid image format", async () => {
    const tool = createImg2TxtAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-vl-max-latest",
      input_: {
        prompt: "请描述这张图片",
        image: "file:///tmp/cat.png",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("input_.image");
  });

  it("rejects unsupported model", async () => {
    const tool = createImg2TxtAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-vl-plus",
      input_: {
        prompt: "请描述这张图片",
        image: "https://img.example/cat.png",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("qwen-vl-max-latest");
  });
});
