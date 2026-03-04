import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImg2ImgAlyTool } from "./index.js";

describe("img2img_aly", () => {
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

    const tool = createImg2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-edit-max",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ image: "https://img.example/input.png" }, { text: "turn it to anime" }],
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
    const tool = createImg2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-edit-plus",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ image: "https://img.example/input.png" }, { text: "turn it to anime" }],
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("qwen-image-edit-max");
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

    const tool = createImg2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-edit-max",
      input_: {
        messages: [
          {
            role: "user",
            content: [
              { image: "data:image/png;base64,AAAA" },
              { text: "turn it to anime" },
              { image: "oss://bucket/tmp.png" },
            ],
          },
        ],
      },
      parameters: '{"size":"1024*1536","n":2,"prompt_extend":true}',
    });

    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("1024*1536");
  });

  it("rejects invalid image format", async () => {
    const tool = createImg2ImgAlyTool({ apiKey: "k", baseUrl: "https://api.example" });
    const result = await tool.execute("call", {
      model: "qwen-image-edit-max",
      input_: {
        messages: [
          {
            role: "user",
            content: [{ image: "/tmp/a.png" }, { text: "turn it to anime" }],
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("public URL");
  });
});
