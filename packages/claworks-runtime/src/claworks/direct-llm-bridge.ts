/**
 * direct-llm-bridge.ts — 独立部署的直连 LLM Bridge
 *
 * ClaWorks 独立运行时（不依赖 OpenClaw/claworks-robot），通过此模块直连：
 *   - OpenAI 兼容接口（包括 Ollama / Qwen / DeepSeek 等本地/私有部署）
 *   - Anthropic Claude API
 *
 * 优先级：
 *   1. opts.llmComplete（外部注入，最高优先级）
 *   2. CLAWORKS_LLM_BASE_URL + CLAWORKS_LLM_API_KEY（任意 OpenAI 兼容接口）
 *   3. ANTHROPIC_API_KEY → Anthropic Claude API
 *   4. OPENAI_API_KEY → OpenAI API
 *   5. OLLAMA_BASE_URL（本地 Ollama，无需 Key）
 *   6. null（无可用 LLM，stub 模式）
 *
 * 企业私域部署只需设置两个环境变量：
 *   CLAWORKS_LLM_BASE_URL=http://your-gpu-server:11434/v1
 *   CLAWORKS_LLM_API_KEY=your-key-or-empty
 */

export type DirectLlmBridgeConfig = {
  /** OpenAI 兼容 Base URL（优先使用此配置） */
  base_url?: string;
  /** API Key */
  api_key?: string;
  /** 默认模型名 */
  model?: string;
  /** 请求超时（毫秒，默认 60s） */
  timeout_ms?: number;
};

export type LlmCompleteFn = (params: {
  prompt: string;
  model?: string;
  system?: string;
}) => Promise<{ text: string }>;

/**
 * 从环境变量和配置自动探测可用 LLM，返回 llmComplete 函数。
 * 返回 null 表示无可用 LLM（系统将以 stub 模式运行）。
 */
export function createDirectLlmBridge(config?: DirectLlmBridgeConfig): LlmCompleteFn | null {
  // 优先使用显式配置的 base_url
  const baseUrl =
    config?.base_url ?? process.env["CLAWORKS_LLM_BASE_URL"] ?? process.env["OPENAI_BASE_URL"];
  const apiKey =
    config?.api_key ??
    process.env["CLAWORKS_LLM_API_KEY"] ??
    process.env["OPENAI_API_KEY"] ??
    process.env["ANTHROPIC_API_KEY"];
  const defaultModel = config?.model ?? process.env["CLAWORKS_LLM_MODEL"] ?? "gpt-4o-mini";
  const timeoutMs = config?.timeout_ms ?? 60_000;

  // Anthropic 路径
  if (!baseUrl && process.env["ANTHROPIC_API_KEY"] && !process.env["OPENAI_API_KEY"]) {
    return createAnthropicBridge(process.env["ANTHROPIC_API_KEY"], defaultModel, timeoutMs);
  }

  // Ollama 路径（无 Key，本地私域最常见）
  const ollamaUrl = baseUrl ?? process.env["OLLAMA_BASE_URL"];
  if (ollamaUrl) {
    const url = ollamaUrl;
    return createOpenAICompatibleBridge(
      url.endsWith("/v1") ? url : `${url}/v1`,
      apiKey ?? "ollama",
      defaultModel,
      timeoutMs,
    );
  }

  // OpenAI 路径
  if (process.env["OPENAI_API_KEY"]) {
    return createOpenAICompatibleBridge(
      "https://api.openai.com/v1",
      process.env["OPENAI_API_KEY"],
      defaultModel,
      timeoutMs,
    );
  }

  return null;
}

// ── OpenAI 兼容接口（支持 Ollama / Qwen / DeepSeek / LocalAI 等）──────────

function createOpenAICompatibleBridge(
  baseUrl: string,
  apiKey: string,
  defaultModel: string,
  timeoutMs: number,
): LlmCompleteFn {
  return async ({ prompt, model, system }) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model ?? defaultModel,
          messages,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`LLM API ${resp.status}: ${body.slice(0, 200)}`);
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      return { text };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Anthropic Claude API ───────────────────────────────────────────────────

function createAnthropicBridge(
  apiKey: string,
  defaultModel: string,
  timeoutMs: number,
): LlmCompleteFn {
  const model = defaultModel.startsWith("claude") ? defaultModel : "claude-3-5-haiku-20241022";

  return async ({ prompt, system }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      };
      if (system) body.system = system;

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`Anthropic API ${resp.status}: ${errBody.slice(0, 200)}`);
      }

      const data = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = data.content?.find((c) => c.type === "text")?.text ?? "";
      return { text };
    } finally {
      clearTimeout(timer);
    }
  };
}
