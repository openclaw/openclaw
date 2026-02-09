---
summary: "모델 프로바이더 개요 및 예시 설정 + CLI 플로우"
read_when:
  - 프로바이더별 모델 설정 참고가 필요할 때
  - 모델 프로바이더용 예시 설정 또는 CLI 온보딩 명령이 필요할 때
title: "모델 프로바이더"
---

# 모델 프로바이더

이 페이지는 **LLM/모델 프로바이더**를 다룹니다 (WhatsApp/Telegram 과 같은 채팅 채널이 아님).
모델 선택 규칙은 [/concepts/models](/concepts/models)를 참조하십시오.

## 빠른 규칙

- 모델 참조는 `provider/model`를 사용합니다 (예: `opencode/claude-opus-4-6`).
- `agents.defaults.models`를 설정하면 allowlist 가 됩니다.
- CLI 헬퍼: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## 내장 프로바이더 (pi‑ai 카탈로그)

OpenClaw 는 pi‑ai 카탈로그와 함께 제공됩니다. 이 프로바이더들은 **`models.providers` 설정이 필요 없습니다**; 인증을 설정하고 모델을 선택하기만 하면 됩니다.

### OpenAI

- 프로바이더: `openai`
- 인증: `OPENAI_API_KEY`
- 예시 모델: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- 프로바이더: `anthropic`
- 인증: `ANTHROPIC_API_KEY` 또는 `claude setup-token`
- 예시 모델: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token 붙여넣기) 또는 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 프로바이더: `openai-codex`
- 인증: OAuth (ChatGPT)
- 예시 모델: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` 또는 `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 프로바이더: `opencode`
- 인증: `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`)
- 예시 모델: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API 키)

- 프로바이더: `google`
- 인증: `GEMINI_API_KEY`
- 예시 모델: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, Gemini CLI

- 프로바이더: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- 인증: Vertex 는 gcloud ADC 를 사용하며, Antigravity/Gemini CLI 는 각각의 인증 플로우를 사용합니다
- Antigravity OAuth 는 번들 플러그인으로 제공됩니다 (`google-antigravity-auth`, 기본적으로 비활성화).
  - 활성화: `openclaw plugins enable google-antigravity-auth`
  - 로그인: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth 는 번들 플러그인으로 제공됩니다 (`google-gemini-cli-auth`, 기본적으로 비활성화).
  - 활성화: `openclaw plugins enable google-gemini-cli-auth`
  - 로그인: `openclaw models auth login --provider google-gemini-cli --set-default`
  - 참고: `openclaw.json`에 클라이언트 id 또는 시크릿을 **붙여넣지 않습니다**. CLI 로그인 플로우는 토큰을 Gateway(게이트웨이) 호스트의 인증 프로필에 저장합니다.

### Z.AI (GLM)

- 프로바이더: `zai`
- 인증: `ZAI_API_KEY`
- 예시 모델: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - 별칭: `z.ai/*` 및 `z-ai/*` 는 `zai/*`로 정규화됩니다

### Vercel AI Gateway

- 프로바이더: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- 예시 모델: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### 기타 내장 프로바이더

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- 예시 모델: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras 의 GLM 모델은 `zai-glm-4.7` 및 `zai-glm-4.6` id 를 사용합니다.
  - OpenAI 호환 base URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## `models.providers` 를 통한 프로바이더 (custom/base URL)

`models.providers` (또는 `models.json`)를 사용하여 **커스텀** 프로바이더 또는
OpenAI/Anthropic 호환 프록시를 추가하십시오.

### Moonshot AI (Kimi)

Moonshot 은 OpenAI 호환 엔드포인트를 사용하므로 커스텀 프로바이더로 구성합니다:

- 프로바이더: `moonshot`
- 인증: `MOONSHOT_API_KEY`
- 예시 모델: `moonshot/kimi-k2.5`

Kimi K2 모델 id:

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

Kimi Coding 은 Moonshot AI 의 Anthropic 호환 엔드포인트를 사용합니다:

- 프로바이더: `kimi-coding`
- 인증: `KIMI_API_KEY`
- 예시 모델: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (무료 티어)

Qwen 은 디바이스 코드 플로우를 통해 Qwen Coder + Vision 에 대한 OAuth 액세스를 제공합니다.
번들 플러그인을 활성화한 다음 로그인하십시오:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

모델 참조:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

설정 세부 사항과 참고 사항은 [/providers/qwen](/providers/qwen)을 참조하십시오.

### Synthetic

Synthetic 는 `synthetic` 프로바이더 뒤에서 Anthropic 호환 모델을 제공합니다:

- 프로바이더: `synthetic`
- 인증: `SYNTHETIC_API_KEY`
- 예시 모델: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax 는 커스텀 엔드포인트를 사용하므로 `models.providers` 를 통해 구성합니다:

- MiniMax (Anthropic 호환): `--auth-choice minimax-api`
- 인증: `MINIMAX_API_KEY`

설정 세부 사항, 모델 옵션, 설정 스니펫은 [/providers/minimax](/providers/minimax)을 참조하십시오.

### Ollama

Ollama 는 OpenAI 호환 API 를 제공하는 로컬 LLM 런타임입니다:

- 프로바이더: `ollama`
- 인증: 필요 없음 (로컬 서버)
- 예시 모델: `ollama/llama3.3`
- 설치: [https://ollama.ai](https://ollama.ai)

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

Ollama 는 `http://127.0.0.1:11434/v1`에서 로컬로 실행 중일 때 자동으로 감지됩니다. 모델 권장 사항과 커스텀 구성은 [/providers/ollama](/providers/ollama)을 참조하십시오.

### 로컬 프록시 (LM Studio, vLLM, LiteLLM 등)

예시 (OpenAI 호환):

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

참고:

- 커스텀 프로바이더의 경우 `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` 는 선택 사항입니다.
  생략하면 OpenClaw 는 다음 기본값을 사용합니다:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 권장 사항: 프록시/모델 제한에 맞는 명시적 값을 설정하십시오.

## CLI 예시

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

전체 구성 예시는 [/gateway/configuration](/gateway/configuration)을 참조하십시오.
