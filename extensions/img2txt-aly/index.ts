import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";

type AlyModel = "qwen-vl-max-latest";

type InputPayload = {
  prompt: string;
  image: string;
};

const ALLOWED_MODELS = new Set<AlyModel>(["qwen-vl-max-latest"]);

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

  const input = raw as { prompt?: unknown; image?: unknown };

  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    fail("input_.prompt required");
  }
  if (input.prompt.length > 800) {
    fail("input_.prompt must be <= 800 characters");
  }

  if (typeof input.image !== "string" || !isImageRef(input.image)) {
    fail("input_.image must be public URL, OSS URL, or base64 data:image string");
  }

  return {
    prompt: input.prompt,
    image: input.image,
  };
}

async function callAly(params: {
  apiKey: string;
  baseUrl: string;
  model: AlyModel;
  input_: InputPayload;
}): Promise<string> {
  const payload = {
    model: params.model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: params.input_.prompt },
            { type: "image", image: params.input_.image },
          ],
        },
      ],
    },
  };

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

  const output = (body as { output?: unknown }).output;
  const choices =
    output && typeof output === "object" ? (output as { choices?: unknown }).choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    fail("Aliyun response has no choices");
  }

  const firstMessage =
    choices[0] && typeof choices[0] === "object"
      ? (choices[0] as { message?: unknown }).message
      : undefined;
  const content =
    firstMessage && typeof firstMessage === "object"
      ? (firstMessage as { content?: unknown }).content
      : undefined;

  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      const text = item && typeof item === "object" ? (item as { text?: unknown }).text : undefined;
      if (typeof text === "string" && text.trim()) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  fail("Aliyun response has no text content");
}

export function createImg2TxtAlyTool(options?: {
  apiKey?: string;
  baseUrl?: string;
}): AnyAgentTool {
  const apiKey = options?.apiKey ?? process.env.OPENCLAW_ALY_API_KEY ?? "";
  const baseUrl =
    options?.baseUrl ??
    process.env.OPENCLAW_ALY_BASE_URL ??
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

  return {
    name: "img2txt_aly",
    description: "根据提示词对图片进行语义级理解和描述。",
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
          description: "输入图像与处理指令",
          properties: {
            prompt: {
              type: "string",
              description: "对图片的处理指令或分析要求",
              minLength: 1,
              maxLength: 800,
            },
            image: {
              type: "string",
              description: "输入图像 URL、OSS URL 或 Base64 data:image",
            },
          },
          required: ["prompt", "image"],
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
          throw new Error("model must be qwen-vl-max-latest");
        }

        const input_ = readInput(record.input_);

        const text = await callAly({
          apiKey,
          baseUrl,
          model,
          input_,
        });

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
          details: {
            model,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "img2txt_aly failed",
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
    createImg2TxtAlyTool({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }),
  );
}
