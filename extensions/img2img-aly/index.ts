import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";

type AlyModel = "qwen-image-edit-max" | "qwen-image-edit-plus" | "qwen-image-edit";

type ImageItem = {
  image: string;
};

type TextItem = {
  text: string;
};

type Message = {
  role: "user";
  content: Array<ImageItem | TextItem>;
};

type InputPayload = {
  messages: [Message];
};

type AlyParameters = {
  n?: number;
  negative_prompt?: string;
  size?: string;
  prompt_extend?: boolean;
  watermark?: boolean;
  seed?: number;
};

const ALLOWED_MODELS = new Set<AlyModel>([
  "qwen-image-edit-max",
  "qwen-image-edit-plus",
  "qwen-image-edit",
]);
const ALLOWED_PARAMETER_KEYS = new Set([
  "n",
  "negative_prompt",
  "size",
  "prompt_extend",
  "watermark",
  "seed",
]);
const SIZE_PATTERN = /^\d{3,4}\*\d{3,4}$/;

function fail(message: string): never {
  throw new Error(message);
}

function isImageRef(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("oss://") ||
    value.startsWith("data:image/")
  );
}

function readInput(raw: unknown): InputPayload {
  if (!raw || typeof raw !== "object") {
    fail("input_ required");
  }
  const input = raw as { messages?: unknown };
  if (!Array.isArray(input.messages) || input.messages.length !== 1) {
    fail("input_.messages must contain exactly one message");
  }

  const message = input.messages[0];
  if (!message || typeof message !== "object") {
    fail("input_.messages[0] invalid");
  }
  const role = (message as { role?: unknown }).role;
  if (role !== "user") {
    fail("input_.messages[0].role must be user");
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length < 2 || content.length > 4) {
    fail("input_.messages[0].content must include 1-3 images and 1 text");
  }

  let imageCount = 0;
  let textCount = 0;

  for (const item of content) {
    if (!item || typeof item !== "object") {
      fail("input_.messages[0].content item invalid");
    }

    const image = (item as { image?: unknown }).image;
    const text = (item as { text?: unknown }).text;

    if (image !== undefined) {
      if (typeof image !== "string" || !isImageRef(image)) {
        fail("image must be public URL, OSS URL, or base64 data:image string");
      }
      imageCount += 1;
      continue;
    }

    if (text !== undefined) {
      if (typeof text !== "string" || !text.trim()) {
        fail("text required");
      }
      if (text.length > 800) {
        fail("text must be <= 800 characters");
      }
      textCount += 1;
      continue;
    }

    fail("each content item must include either image or text");
  }

  if (imageCount < 1 || imageCount > 3) {
    fail("must include 1-3 images");
  }
  if (textCount !== 1) {
    fail("must include exactly one text item");
  }

  return raw as InputPayload;
}

function parseParameters(raw: unknown): AlyParameters | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail("parameters must be a valid JSON object string");
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("parameters must be an object");
  }

  const input = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !ALLOWED_PARAMETER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    fail(`parameters has unknown fields: ${unknownKeys.join(", ")}`);
  }

  const out: AlyParameters = {};

  if (input.n !== undefined && input.n !== null) {
    if (typeof input.n !== "number" || !Number.isInteger(input.n) || input.n < 1 || input.n > 6) {
      fail("parameters.n must be an integer in [1, 6]");
    }
    out.n = input.n;
  }

  if (input.negative_prompt !== undefined && input.negative_prompt !== null) {
    if (typeof input.negative_prompt !== "string") {
      fail("parameters.negative_prompt must be a string");
    }
    if (input.negative_prompt.length > 500) {
      fail("parameters.negative_prompt must be <= 500 characters");
    }
    out.negative_prompt = input.negative_prompt;
  }

  if (input.size !== undefined && input.size !== null) {
    if (typeof input.size !== "string" || !SIZE_PATTERN.test(input.size)) {
      fail('parameters.size must match "<width>*<height>"');
    }
    const [width, height] = input.size.split("*").map((n) => Number.parseInt(n, 10));
    if (width < 512 || width > 2048 || height < 512 || height > 2048) {
      fail("parameters.size width/height must be in [512, 2048]");
    }
    out.size = input.size;
  }

  if (input.prompt_extend !== undefined && input.prompt_extend !== null) {
    if (typeof input.prompt_extend !== "boolean") {
      fail("parameters.prompt_extend must be boolean");
    }
    out.prompt_extend = input.prompt_extend;
  }

  if (input.watermark !== undefined && input.watermark !== null) {
    if (typeof input.watermark !== "boolean") {
      fail("parameters.watermark must be boolean");
    }
    out.watermark = input.watermark;
  }

  if (input.seed !== undefined && input.seed !== null) {
    if (typeof input.seed !== "number" || !Number.isInteger(input.seed)) {
      fail("parameters.seed must be an integer");
    }
    if (input.seed < 0 || input.seed > 2147483647) {
      fail("parameters.seed must be in [0, 2147483647]");
    }
    out.seed = input.seed;
  }

  return out;
}

async function callAly(params: {
  apiKey: string;
  baseUrl: string;
  model: AlyModel;
  input_: InputPayload;
  parameters?: AlyParameters;
}): Promise<string[]> {
  const payload: Record<string, unknown> = {
    model: params.model,
    input: params.input_,
  };
  if (params.parameters && Object.keys(params.parameters).length > 0) {
    payload.parameters = params.parameters;
  }

  const resp = await fetch(params.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    fail(`Aliyun request failed with status ${resp.status}: ${JSON.stringify(body)}`);
  }
  if (!body || typeof body !== "object") {
    fail("Aliyun response is invalid");
  }
  if (Object.hasOwn(body, "code")) {
    fail(`Aliyun returned an error: ${JSON.stringify(body)}`);
  }

  const urls: string[] = [];
  const output = (body as { output?: unknown }).output;
  const choices =
    output && typeof output === "object" ? (output as { choices?: unknown }).choices : undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message =
        choice && typeof choice === "object"
          ? (choice as { message?: unknown }).message
          : undefined;
      const content =
        message && typeof message === "object"
          ? (message as { content?: unknown }).content
          : undefined;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const item of content) {
        const image =
          item && typeof item === "object" ? (item as { image?: unknown }).image : undefined;
        if (typeof image === "string" && image.trim()) {
          urls.push(image);
        }
      }
    }
  }
  return urls;
}

export function createImg2ImgAlyTool(options?: {
  apiKey?: string;
  baseUrl?: string;
}): AnyAgentTool {
  const apiKey = options?.apiKey ?? process.env.OPENCLAW_ALY_API_KEY ?? "";
  const baseUrl =
    options?.baseUrl ??
    process.env.OPENCLAW_ALY_BASE_URL ??
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

  return {
    name: "img2img_aly",
    description:
      "图像编辑工具。\n---\n注意：\n- model 的值目前只支持 `qwen-image-edit-max`\n- 正向提示词，不能超过800字符",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "模型名称",
          enum: Array.from(ALLOWED_MODELS),
        },
        input_: {
          type: "object",
          description: "输入基本信息",
          properties: {
            messages: {
              type: "array",
              description: "请求内容数组，仅支持单轮对话",
              minItems: 1,
              maxItems: 1,
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    const: "user",
                    description: "消息角色，必须为 user",
                  },
                  content: {
                    type: "array",
                    description: "包含1-3张图像和1个text",
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: "object",
                      properties: {
                        image: {
                          type: "string",
                          description: "输入图像 URL、OSS URL 或 Base64 data:image",
                        },
                        text: {
                          type: "string",
                          description: "正向提示词，不超过800字符",
                          minLength: 1,
                          maxLength: 800,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                required: ["role", "content"],
                additionalProperties: false,
              },
            },
          },
          required: ["messages"],
          additionalProperties: false,
        },
        parameters: {
          type: "object",
          description: "图像生成附加参数",
          properties: {
            n: {
              type: "integer",
              default: 1,
              minimum: 1,
              maximum: 6,
              description: "输出图像数量",
            },
            negative_prompt: {
              type: "string",
              maxLength: 500,
              description: "反向提示词，不超过500字符",
            },
            size: {
              type: "string",
              pattern: "^\\d{3,4}\\*\\d{3,4}$",
              description: '分辨率格式，例如 "1024*1536"',
            },
            prompt_extend: {
              type: "boolean",
              default: true,
              description: "是否开启提示词智能改写",
            },
            watermark: {
              type: "boolean",
              default: false,
              description: "是否添加水印",
            },
            seed: {
              type: "integer",
              minimum: 0,
              maximum: 2147483647,
              description: "随机数种子",
            },
          },
          additionalProperties: false,
        },
      },
      required: ["model", "input_"],
      additionalProperties: false,
    },

    async execute(_id, params) {
      try {
        if (!apiKey) {
          throw new Error("OPENCLAW_ALY_API_KEY not configured");
        }
        if (!params || typeof params !== "object") {
          throw new Error("params required");
        }

        const record = params as Record<string, unknown>;
        const model = record.model;
        if (!ALLOWED_MODELS.has(model as AlyModel)) {
          throw new Error(
            "model must be one of qwen-image-edit-max, qwen-image-edit-plus, qwen-image-edit",
          );
        }
        if (model !== "qwen-image-edit-max") {
          throw new Error("model 的值目前只支持 `qwen-image-edit-max`");
        }

        const input_ = readInput(record.input_);
        const parsedParameters = parseParameters(record.parameters);

        const urls = await callAly({
          apiKey,
          baseUrl,
          model,
          input_,
          parameters: parsedParameters,
        });

        if (urls.length === 0) {
          throw new Error("Aliyun response has no generated image URLs");
        }

        return {
          content: [
            {
              type: "text",
              text: [`已生成 ${urls.length} 张图片：`, ...urls.map((url) => `- ${url}`)].join("\n"),
            },
          ],
          details: {
            model,
            count: urls.length,
            urls,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "img2img_aly failed",
            },
          ],
          isError: true,
        };
      }
    },
  };
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as { apiKey?: string; baseUrl?: string };

  api.registerTool(
    createImg2ImgAlyTool({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }),
  );
}
