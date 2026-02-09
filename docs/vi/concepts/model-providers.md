---
summary: "Tổng quan nhà cung cấp mô hình với cấu hình mẫu + luồng CLI"
read_when:
  - Bạn cần tài liệu tham chiếu thiết lập mô hình theo từng nhà cung cấp
  - Bạn muốn xem cấu hình mẫu hoặc các lệnh CLI hướng dẫn ban đầu cho nhà cung cấp mô hình
title: "Nhà cung cấp mô hình"
---

# Nhà cung cấp mô hình

This page covers **LLM/model providers** (not chat channels like WhatsApp/Telegram).
Để biết quy tắc chọn model, xem [/concepts/models](/concepts/models).

## Quy tắc nhanh

- Tham chiếu mô hình dùng `provider/model` (ví dụ: `opencode/claude-opus-4-6`).
- Nếu bạn đặt `agents.defaults.models`, nó sẽ trở thành danh sách cho phép.
- Trợ giúp CLI: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Nhà cung cấp tích hợp sẵn (danh mục pi‑ai)

OpenClaw được phát hành kèm catalog pi‑ai. Các nhà cung cấp này **không yêu cầu**
cấu hình `models.providers`; chỉ cần đặt auth + chọn một mô hình.

### OpenAI

- Nhà cung cấp: `openai`
- Xác thực: `OPENAI_API_KEY`
- Ví dụ mô hình: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Nhà cung cấp: `anthropic`
- Xác thực: `ANTHROPIC_API_KEY` hoặc `claude setup-token`
- Ví dụ mô hình: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (dán setup-token) hoặc `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Nhà cung cấp: `openai-codex`
- Xác thực: OAuth (ChatGPT)
- Ví dụ mô hình: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` hoặc `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Nhà cung cấp: `opencode`
- Xác thực: `OPENCODE_API_KEY` (hoặc `OPENCODE_ZEN_API_KEY`)
- Ví dụ mô hình: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (khóa API)

- Nhà cung cấp: `google`
- Xác thực: `GEMINI_API_KEY`
- Ví dụ mô hình: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity và Gemini CLI

- Nhà cung cấp: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Xác thực: Vertex dùng gcloud ADC; Antigravity/Gemini CLI dùng các luồng xác thực tương ứng
- OAuth Antigravity được phát hành như một plugin đóng gói (`google-antigravity-auth`, mặc định tắt).
  - Bật: `openclaw plugins enable google-antigravity-auth`
  - Đăng nhập: `openclaw models auth login --provider google-antigravity --set-default`
- OAuth Gemini CLI được phát hành như một plugin đóng gói (`google-gemini-cli-auth`, mặc định tắt).
  - Bật: `openclaw plugins enable google-gemini-cli-auth`
  - Đăng nhập: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Lưu ý: bạn **không** dán client id hoặc secret vào `openclaw.json`. Luồng đăng nhập CLI lưu trữ token trong các hồ sơ xác thực trên máy chủ gateway.

### Z.AI (GLM)

- Nhà cung cấp: `zai`
- Xác thực: `ZAI_API_KEY`
- Ví dụ mô hình: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Bí danh: `z.ai/*` và `z-ai/*` được chuẩn hóa thành `zai/*`

### Vercel AI Gateway

- Nhà cung cấp: `vercel-ai-gateway`
- Xác thực: `AI_GATEWAY_API_KEY`
- Ví dụ mô hình: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Các nhà cung cấp tích hợp sẵn khác

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Ví dụ mô hình: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Các mô hình GLM trên Cerebras dùng id `zai-glm-4.7` và `zai-glm-4.6`.
  - Base URL tương thích OpenAI: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## Nhà cung cấp qua `models.providers` (URL tùy chỉnh/cơ sở)

Dùng `models.providers` (hoặc `models.json`) để thêm **nhà cung cấp tùy chỉnh** hoặc
các proxy tương thích OpenAI/Anthropic.

### Moonshot AI (Kimi)

Moonshot dùng các endpoint tương thích OpenAI, vì vậy hãy cấu hình như một nhà cung cấp tùy chỉnh:

- Nhà cung cấp: `moonshot`
- Xác thực: `MOONSHOT_API_KEY`
- Ví dụ mô hình: `moonshot/kimi-k2.5`

ID mô hình Kimi K2:

{/_moonshot-kimi-k2-model-refs:start_/ && null}

- `moonshot/kimi-k2.5`
- `moonshot/kimi-k2-0905-preview`
- `moonshot/kimi-k2-turbo-preview`
- `moonshot/kimi-k2-thinking`
- `moonshot/kimi-k2-thinking-turbo`
  {/_moonshot-kimi-k2-model-refs:end_/ && null}

```json5
{
  agents: {
    defaults: { model: { primary: "moonshot/kimi-k2.5" } },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
}
```

### Kimi Coding

Kimi Coding dùng endpoint tương thích Anthropic của Moonshot AI:

- Nhà cung cấp: `kimi-coding`
- Xác thực: `KIMI_API_KEY`
- Ví dụ mô hình: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (gói miễn phí)

Qwen cung cấp quyền truy cập OAuth vào Qwen Coder + Vision thông qua luồng device-code.
Bật plugin đi kèm, sau đó đăng nhập:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Tham chiếu mô hình:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Xem [/providers/qwen](/providers/qwen) để biết chi tiết thiết lập và lưu ý.

### Synthetic

Synthetic cung cấp các mô hình tương thích Anthropic phía sau nhà cung cấp `synthetic`:

- Nhà cung cấp: `synthetic`
- Xác thực: `SYNTHETIC_API_KEY`
- Ví dụ mô hình: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- CLI: `openclaw onboard --auth-choice synthetic-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" } },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [{ id: "hf:MiniMaxAI/MiniMax-M2.1", name: "MiniMax M2.1" }],
      },
    },
  },
}
```

### MiniMax

MiniMax được cấu hình qua `models.providers` vì nó dùng các endpoint tùy chỉnh:

- MiniMax (tương thích Anthropic): `--auth-choice minimax-api`
- Xác thực: `MINIMAX_API_KEY`

Xem [/providers/minimax](/providers/minimax) để biết chi tiết thiết lập, tùy chọn mô hình và các đoạn cấu hình.

### Ollama

Ollama là một runtime LLM cục bộ cung cấp API tương thích OpenAI:

- Nhà cung cấp: `ollama`
- Xác thực: Không cần (máy chủ cục bộ)
- Ví dụ mô hình: `ollama/llama3.3`
- Cài đặt: [https://ollama.ai](https://ollama.ai)

```bash
# Install Ollama, then pull a model:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama được tự động phát hiện khi chạy cục bộ tại `http://127.0.0.1:11434/v1`. See [/providers/ollama](/providers/ollama) for model recommendations and custom configuration.

### Proxy cục bộ (LM Studio, vLLM, LiteLLM, v.v.)

Ví dụ (tương thích OpenAI):

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "LMSTUDIO_KEY",
        api: "openai-completions",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Ghi chú:

- Đối với các provider tùy chỉnh, `reasoning`, `input`, `cost`, `contextWindow` và `maxTokens` là tùy chọn.
  Khi bị lược bỏ, OpenClaw mặc định:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Khuyến nghị: đặt giá trị tường minh phù hợp với giới hạn proxy/mô hình của bạn.

## Ví dụ CLI

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Xem thêm: [/gateway/configuration](/gateway/configuration) để biết các ví dụ cấu hình đầy đủ.
