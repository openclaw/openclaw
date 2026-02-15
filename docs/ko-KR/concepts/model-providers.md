---
summary: "Model provider overview with example configs + CLI flows"
read_when:
  - You need a provider-by-provider model setup reference
  - You want example configs or CLI onboarding commands for model providers
title: "Model Providers"
x-i18n:
  source_hash: b086e62236225de63fcc2a910c49b127641407c59e47ce35cf88b0cb60e30181
---

# 모델 제공자

이 페이지에서는 **LLM/모델 제공자**(WhatsApp/Telegram과 같은 채팅 채널 아님)를 다룹니다.
모델 선택 규칙은 [/concepts/models](/concepts/models)를 참조하세요.

## 빠른 규칙

- 모델 참조는 `provider/model`를 사용합니다(예: `opencode/claude-opus-4-6`).
- `agents.defaults.models`로 설정하면 허용 목록이 됩니다.
- CLI 도우미: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## 내장 공급자(pi-ai 카탈로그)

OpenClaw는 pi-ai 카탈로그와 함께 제공됩니다. 이러한 제공업체에는 **아니요**가 필요합니다.
`models.providers` 구성; 인증을 설정하고 모델을 선택하세요.

### 오픈AI

- 제공자 : `openai`
- 인증: `OPENAI_API_KEY`
- 예시 모델 : `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### 인류학

- 제공자 : `anthropic`
- 인증: `ANTHROPIC_API_KEY` 또는 `claude setup-token`
- 예시 모델 : `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (설정 토큰 붙여넣기) 또는 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI 코드(코덱스)

- 제공자 : `openai-codex`
- 인증: OAuth(ChatGPT)
- 예시 모델 : `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` 또는 `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### 오픈코드 젠

- 제공자 : `opencode`
- 인증: `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`)
- 예시 모델 : `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini(API 키)

- 제공자 : `google`
- 인증: `GEMINI_API_KEY`
- 예시 모델 : `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity 및 Gemini CLI

- 제공자: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- 인증: Vertex는 gcloud ADC를 사용합니다. Antigravity/Gemini CLI는 각각의 인증 흐름을 사용합니다.
- Antigravity OAuth는 번들 플러그인으로 제공됩니다(`google-antigravity-auth`, 기본적으로 비활성화됨).
  - 활성화: `openclaw plugins enable google-antigravity-auth`
  - 로그인 : `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth는 번들 플러그인으로 제공됩니다(`google-gemini-cli-auth`, 기본적으로 비활성화됨).
  - 활성화: `openclaw plugins enable google-gemini-cli-auth`
  - 로그인 : `openclaw models auth login --provider google-gemini-cli --set-default`
  - 참고: `openclaw.json`에 클라이언트 ID나 비밀번호를 붙여넣지 **않습니다**. CLI 로그인 흐름은 다음을 저장합니다.
    게이트웨이 호스트의 인증 프로필에 있는 토큰.

### Z.AI (GLM)

- 제공자 : `zai`
- 인증: `ZAI_API_KEY`
- 예시 모델 : `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - 별칭: `z.ai/*` 및 `z-ai/*`는 `zai/*`로 정규화됩니다.

### Vercel AI 게이트웨이

- 제공자 : `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- 예시 모델 : `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### 기타 내장 공급자

- 오픈라우터: `openrouter` (`OPENROUTER_API_KEY`)
- 예시 모델 : `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- 그로크: `groq` (`GROQ_API_KEY`)
- 대뇌: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras의 GLM 모델은 ID `zai-glm-4.7` 및 `zai-glm-4.6`를 사용합니다.
  - OpenAI 호환 기본 URL: `https://api.cerebras.ai/v1`.
- 미스트랄: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)

## `models.providers`를 통한 제공자(사용자 정의/기본 URL)

`models.providers`(또는 `models.json`)를 사용하여 **사용자 정의** 공급자를 추가하거나
OpenAI/Anthropic 호환 프록시.

### 문샷 AI(키미)

Moonshot은 OpenAI 호환 엔드포인트를 사용하므로 이를 사용자 지정 공급자로 구성합니다.

- 제공자 : `moonshot`
- 인증: `MOONSHOT_API_KEY`
- 예시 모델 : `moonshot/kimi-k2.5`

Kimi K2 모델 ID:

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

### 키미코딩

Kimi Coding은 Moonshot AI의 Anthropic 호환 엔드포인트를 사용합니다.

- 제공자 : `kimi-coding`
- 인증: `KIMI_API_KEY`
- 예시 모델 : `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth(무료 등급)

Qwen은 장치 코드 흐름을 통해 Qwen Coder + Vision에 대한 OAuth 액세스를 제공합니다.
번들 플러그인을 활성화한 후 로그인하세요.

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

모델 참조:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

설정 세부 사항 및 참고 사항은 [/providers/qwen](/providers/qwen)를 참조하세요.

### 합성

Synthetic은 `synthetic` 제공자 뒤에 Anthropic 호환 모델을 제공합니다.

- 제공자 : `synthetic`
- 인증: `SYNTHETIC_API_KEY`
- 예시 모델 : `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

### 미니맥스

MiniMax는 사용자 정의 엔드포인트를 사용하므로 `models.providers`를 통해 구성됩니다.

- MiniMax(인류 호환): `--auth-choice minimax-api`
- 인증: `MINIMAX_API_KEY`

설정 세부사항, 모델 옵션 및 구성 스니펫은 [/providers/minimax](/providers/minimax)를 참조하세요.

### 올라마

Ollama는 OpenAI 호환 API를 제공하는 로컬 LLM 런타임입니다.

- 제공자 : `ollama`
- 인증: 없음(로컬 서버)
- 예시 모델 : `ollama/llama3.3`
- 설치 : [https://ollama.ai](https://ollama.ai)

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

Ollama는 `http://127.0.0.1:11434/v1`에서 로컬로 실행될 때 자동으로 감지됩니다. 모델 권장 사항 및 사용자 정의 구성은 [/providers/ollama](/providers/ollama)를 참조하세요.

### 로컬 프록시(LM Studio, vLLM, LiteLLM 등)

예(OpenAI 호환):

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

- 사용자 정의 공급자의 경우 `reasoning`, `input`, `cost`, `contextWindow` 및 `maxTokens`는 선택 사항입니다.
  생략하면 OpenClaw의 기본값은 다음과 같습니다.
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 권장 사항: 프록시/모델 제한과 일치하는 명시적인 값을 설정하세요.

## CLI 예

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

전체 구성 예는 [/gateway/configuration](/gateway/configuration)를 참조하세요.
