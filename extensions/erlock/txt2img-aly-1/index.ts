import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";

type Txt2ImgArgs = {
  model: string;
  input_: {
    messages: Array<{
      role: "user";
      content: Array<{ text: string }>;
    }>;
  };
  parameters?: {
    negative_prompt?: string;
    size?: "1664*928" | "1472*1104" | "1328*1328" | "1104*1472" | "928*1664";
    n?: 1;
    seed?: number;
  };
};

const ALLOWED_SIZES = new Set(["1664*928", "1472*1104", "1328*1328", "1104*1472", "928*1664"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(raw: unknown): Txt2ImgArgs {
  if (!isRecord(raw)) {
    throw new Error("params required");
  }

  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (model !== "qwen-image-max") {
    throw new Error("model 的值目前只支持 `qwen-image-max`");
  }

  const inputRaw = raw.input_;
  if (!isRecord(inputRaw) || !Array.isArray(inputRaw.messages) || inputRaw.messages.length !== 1) {
    throw new Error("input_.messages 仅支持单轮对话");
  }

  const message = inputRaw.messages[0];
  if (!isRecord(message) || message.role !== "user") {
    throw new Error("message.role 必须为 user");
  }
  if (
    !Array.isArray(message.content) ||
    message.content.length !== 1 ||
    !isRecord(message.content[0])
  ) {
    throw new Error("message.content 仅允许一个 text");
  }

  const text = typeof message.content[0].text === "string" ? message.content[0].text.trim() : "";
  if (!text) {
    throw new Error("text required");
  }
  if (text.length > 800) {
    throw new Error("text 最长800字符");
  }

  const parsed: Txt2ImgArgs = {
    model,
    input_: {
      messages: [{ role: "user", content: [{ text }] }],
    },
  };

  if (!Object.hasOwn(raw, "parameters") || raw.parameters == null) {
    return parsed;
  }

  let parametersRaw = raw.parameters;
  if (typeof parametersRaw === "string") {
    const trimmed = parametersRaw.trim();
    if (!trimmed) {
      throw new Error("parameters must be an object");
    }
    try {
      parametersRaw = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error("parameters JSON string is invalid");
    }
  }

  if (!isRecord(parametersRaw)) {
    throw new Error("parameters must be an object");
  }

  const parameters: Txt2ImgArgs["parameters"] = {};
  if (Object.hasOwn(parametersRaw, "negative_prompt")) {
    const value = parametersRaw.negative_prompt;
    if (typeof value !== "string") {
      throw new Error("negative_prompt must be a string");
    }
    if (value.length > 500) {
      throw new Error("negative_prompt 最长500字符");
    }
    parameters.negative_prompt = value;
  }

  if (Object.hasOwn(parametersRaw, "size")) {
    const value = parametersRaw.size;
    if (typeof value !== "string" || !ALLOWED_SIZES.has(value)) {
      throw new Error("size 不是支持的分辨率");
    }
    parameters.size = value as Txt2ImgArgs["parameters"]["size"];
  }

  if (Object.hasOwn(parametersRaw, "n")) {
    if (parametersRaw.n !== 1) {
      throw new Error("n 仅支持1");
    }
    parameters.n = 1;
  }

  if (Object.hasOwn(parametersRaw, "seed")) {
    const value = parametersRaw.seed;
    if (!Number.isInteger(value) || value < 0 || value >= 2147483648) {
      throw new Error("seed 范围[0,2147483647]");
    }
    parameters.seed = value;
  }

  if (Object.keys(parameters).length > 0) {
    parsed.parameters = parameters;
  }
  return parsed;
}

function extractImageUrls(payload: Record<string, unknown>): string[] {
  const output = isRecord(payload.output) ? payload.output : null;
  const choices = output && Array.isArray(output.choices) ? output.choices : [];
  const urls: string[] = [];

  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (isRecord(item) && typeof item.image === "string" && item.image.trim()) {
        urls.push(item.image);
      }
    }
  }

  return urls;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function createTxt2ImgAlyTool(options?: {
  apiKey?: string;
  baseUrl?: string;
}): AnyAgentTool {
  const apiKey = options?.apiKey ?? process.env.OPENCLAW_ALY_API_KEY ?? "";
  const baseUrl =
    options?.baseUrl ??
    process.env.OPENCLAW_ALY_BASE_URL ??
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis";

  return {
    name: "txt2img_aly",
    description: "基于文本生成图片。",
    parameters: {
      properties: {
        model: { description: "模型名称，例如 qwen-image-max", type: "string" },
        input_: {
          properties: {
            messages: {
              description: "请求内容数组，仅支持单轮对话",
              items: {
                properties: {
                  role: {
                    const: "user",
                    description: "消息角色，必须为 user",
                    type: "string",
                  },
                  content: {
                    description: "消息内容数组，仅允许一个 text",
                    items: {
                      properties: {
                        text: {
                          description:
                            "正向提示词，用于描述期望生成的图像内容、风格和构图。支持中英文，最长800字符。",
                          maxLength: 800,
                          type: "string",
                        },
                      },
                      required: ["text"],
                      type: "object",
                    },
                    maxItems: 1,
                    minItems: 1,
                    type: "array",
                  },
                },
                required: ["role", "content"],
                type: "object",
              },
              maxItems: 1,
              minItems: 1,
              type: "array",
            },
          },
          required: ["messages"],
          type: "object",
          description: "输入基本信息",
        },
        parameters: {
          type: "object",
          description: "图像生成参数",
          properties: {
            negative_prompt: {
              maxLength: 500,
              type: "string",
              description: "反向提示词，最长500字符",
            },
            size: {
              enum: ["1664*928", "1472*1104", "1328*1328", "1104*1472", "928*1664"],
              type: "string",
              description: "输出图像分辨率",
            },
            n: {
              const: 1,
              type: "integer",
              description: "生成图像数量，仅支持1",
            },
            seed: {
              exclusiveMaximum: 2147483648,
              minimum: 0,
              type: "integer",
              description: "随机种子，范围[0,2147483647]",
            },
          },
          additionalProperties: false,
        },
      },
      required: ["model", "input_"],
      type: "object",
    },

    async execute(_id, params) {
      try {
        const parsed = parseArgs(params);

        if (!apiKey) {
          return errorResult("OPENCLAW_ALY_API_KEY is required");
        }

        const reqPayload: Record<string, unknown> = {
          model: parsed.model,
          input: parsed.input_,
        };

        if (parsed.parameters) {
          reqPayload.parameters = parsed.parameters;
        }

        const response = await fetch(baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(reqPayload),
        });

        const data = (await response.json()) as Record<string, unknown>;

        if (Object.hasOwn(data, "code")) {
          throw new Error(`There was an error: ${JSON.stringify(data)}`);
        }

        const urls = extractImageUrls(data);
        if (urls.length === 0) {
          throw new Error(`There are no images in ${JSON.stringify(data)}`);
        }

        return {
          content: [
            { type: "text" as const, text: `Generated ${urls.length} image(s)` },
            {
              type: "text" as const,
              text: urls.join("\n"),
            },
          ],
          details: {
            urls,
            model: parsed.model,
          },
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "txt2img_aly failed");
      }
    },
  };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as { apiKey?: string; baseUrl?: string };

  api.registerTool(
    createTxt2ImgAlyTool({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }),
  );
}
