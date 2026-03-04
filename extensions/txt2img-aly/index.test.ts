import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTxt2ImgAlyTool } from "./index.js";

describe("txt2img_aly", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns image URLs from Aliyun response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: {
          choices: [
            {
              message: {
                content: [{ image: "https://img.example/a.png" }],
              },
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createTxt2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-max",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ text: "a cat" }],
          },
        ],
      },
      parameters: { n: 1 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("https://img.example/a.png");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects unsupported model", async () => {
    const tool = createTxt2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-plus",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ text: "a cat" }],
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("qwen-image-max");
  });

  it("supports JSON string parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: {
          choices: [
            {
              message: {
                content: [{ image: "https://img.example/b.png" }],
              },
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createTxt2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-max",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ text: "a cat" }],
          },
        ],
      },
      parameters: '{"size":"1328*1328","n":1}',
    });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("1328*1328");
  });

  it("rejects unknown parameters fields", async () => {
    const tool = createTxt2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-max",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ text: "a cat" }],
          },
        ],
      },
      parameters: { foo: "bar" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown fields");
  });
});
