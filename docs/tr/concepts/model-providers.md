---
summary: "Örnek yapılandırmalar + CLI akışlarıyla model sağlayıcılarına genel bakış"
read_when:
  - Sağlayıcı bazında model kurulum başvurusuna ihtiyaç duyduğunuzda
  - Model sağlayıcıları için örnek yapılandırmalar veya CLI ile başlangıç komutları istediğinizde
title: "Model Sağlayıcıları"
---

# Model sağlayıcıları

Bu sayfa **LLM/model sağlayıcılarını** kapsar (WhatsApp/Telegram gibi sohbet kanalları değil).
Model seçim kuralları için bkz. [/concepts/models](/concepts/models).

## Hızlı kurallar

- Model referansları `provider/model` kullanır (örnek: `opencode/claude-opus-4-6`).
- `agents.defaults.models` ayarlarsanız, bu izin listesi (allowlist) olur.
- CLI yardımcıları: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## Yerleşik sağlayıcılar (pi-ai kataloğu)

OpenClaw, pi‑ai kataloğu ile birlikte gelir. Bu sağlayıcılar **herhangi bir**
`models.providers` yapılandırması gerektirmez; yalnızca kimlik doğrulamayı ayarlayın ve bir model seçin.

### OpenAI

- Sağlayıcı: `openai`
- Kimlik doğrulama: `OPENAI_API_KEY`
- Örnek model: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- Sağlayıcı: `anthropic`
- Kimlik doğrulama: `ANTHROPIC_API_KEY` veya `claude setup-token`
- Örnek model: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token yapıştırın) veya `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- Sağlayıcı: `openai-codex`
- Kimlik doğrulama: OAuth (ChatGPT)
- Örnek model: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` veya `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- Sağlayıcı: `opencode`
- Kimlik doğrulama: `OPENCODE_API_KEY` (veya `OPENCODE_ZEN_API_KEY`)
- Örnek model: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API anahtarı)

- Sağlayıcı: `google`
- Kimlik doğrulama: `GEMINI_API_KEY`
- Örnek model: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity ve Gemini CLI

- Sağlayıcılar: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- Kimlik doğrulama: Vertex gcloud ADC kullanır; Antigravity/Gemini CLI kendi kimlik doğrulama akışlarını kullanır
- Antigravity OAuth, paketlenmiş bir eklenti olarak sunulur (`google-antigravity-auth`, varsayılan olarak devre dışıdır).
  - Etkinleştir: `openclaw plugins enable google-antigravity-auth`
  - Giriş: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth, paketlenmiş bir eklenti olarak sunulur (`google-gemini-cli-auth`, varsayılan olarak devre dışıdır).
  - Etkinleştir: `openclaw plugins enable google-gemini-cli-auth`
  - Giriş: `openclaw models auth login --provider google-gemini-cli --set-default`
  - Not: `openclaw.json` içine **istemci kimliği veya gizli anahtar yapıştırmazsınız**. CLI giriş akışı,
    belirteçleri gateway ana makinesindeki kimlik doğrulama profillerinde saklar.

### Z.AI (GLM)

- Sağlayıcı: `zai`
- Kimlik doğrulama: `ZAI_API_KEY`
- Örnek model: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - Takma adlar: `z.ai/*` ve `z-ai/*`, `zai/*`’e normalize edilir

### Vercel AI Gateway

- Sağlayıcı: `vercel-ai-gateway`
- Kimlik doğrulama: `AI_GATEWAY_API_KEY`
- Örnek model: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Diğer yerleşik sağlayıcılar

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- Örnek model: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras üzerindeki GLM modelleri `zai-glm-4.7` ve `zai-glm-4.6` kimliklerini kullanır.
  - OpenAI‑uyumlu temel URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## `models.providers` üzerinden sağlayıcılar (özel/temel URL)

**Özel** sağlayıcılar veya
OpenAI/Anthropic‑uyumlu proxy’ler eklemek için `models.providers` (veya `models.json`) kullanın.

### Moonshot AI (Kimi)

Moonshot, OpenAI‑uyumlu uç noktalar kullanır; bu nedenle özel bir sağlayıcı olarak yapılandırın:

- Sağlayıcı: `moonshot`
- Kimlik doğrulama: `MOONSHOT_API_KEY`
- Örnek model: `moonshot/kimi-k2.5`

Kimi K2 model kimlikleri:

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

Kimi Coding, Moonshot AI’nin Anthropic‑uyumlu uç noktasını kullanır:

- Sağlayıcı: `kimi-coding`
- Kimlik doğrulama: `KIMI_API_KEY`
- Örnek model: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (ücretsiz katman)

Qwen, cihaz kodu akışı üzerinden Qwen Coder + Vision için OAuth erişimi sağlar.
Paketlenmiş eklentiyi etkinleştirin, ardından giriş yapın:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

Model referansları:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

Kurulum ayrıntıları ve notlar için bkz. [/providers/qwen](/providers/qwen).

### Synthetic

Synthetic, `synthetic` sağlayıcısı arkasında Anthropic‑uyumlu modeller sunar:

- Sağlayıcı: `synthetic`
- Kimlik doğrulama: `SYNTHETIC_API_KEY`
- Örnek model: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax, özel uç noktalar kullandığı için `models.providers` üzerinden yapılandırılır:

- MiniMax (Anthropic‑uyumlu): `--auth-choice minimax-api`
- Kimlik doğrulama: `MINIMAX_API_KEY`

Kurulum ayrıntıları, model seçenekleri ve yapılandırma parçacıkları için bkz. [/providers/minimax](/providers/minimax).

### Ollama

Ollama, OpenAI‑uyumlu bir API sağlayan yerel bir LLM çalışma zamanıdır:

- Sağlayıcı: `ollama`
- Kimlik doğrulama: Gerekmez (yerel sunucu)
- Örnek model: `ollama/llama3.3`
- Kurulum: [https://ollama.ai](https://ollama.ai)

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

Ollama, `http://127.0.0.1:11434/v1` adresinde yerel olarak çalışırken otomatik olarak algılanır. Model önerileri ve özel yapılandırma için bkz. [/providers/ollama](/providers/ollama).

### Yerel proxy’ler (LM Studio, vLLM, LiteLLM, vb.)

Örnek (OpenAI‑uyumlu):

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

Notlar:

- Özel sağlayıcılar için `reasoning`, `input`, `cost`, `contextWindow` ve `maxTokens` isteğe bağlıdır.
  Atlandığında OpenClaw varsayılan olarak şunları kullanır:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- Önerilen: proxy/model sınırlarınızla uyumlu açık değerler belirleyin.

## CLI örnekleri

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

Ayrıca bkz.: Tam yapılandırma örnekleri için [/gateway/configuration](/gateway/configuration).
