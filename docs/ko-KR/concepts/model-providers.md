---
summary: "모델 프로바이더 개요 및 예제 설정 + CLI 흐름"
read_when:
  - 프로바이더별 모델 설정 참조가 필요할 때
  - 모델 프로바이더에 대한 예제 설정 또는 CLI 온보딩 명령어가 필요할 때
title: "모델 프로바이더"
---

# 모델 프로바이더

이 페이지는 **LLM/모델 프로바이더**를 다루며 (WhatsApp/Telegram 같은 채널은 아닙니다).
모델 선택 규칙에 대해서는 [/concepts/models](/ko-KR/concepts/models)를 참조하세요.

## 빠른 규칙

- 모델 참조는 `provider/model`을 사용합니다 (예: `opencode/claude-opus-4-6`).
- `agents.defaults.models`를 설정하면 허용 목록이 됩니다.
- CLI 도우미: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## API 키 로테이션

- 선택된 프로바이더에 대해 일반 프로바이더 로테이션을 지원합니다.
- 다음을 통해 여러 키를 구성할 수 있습니다:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (단일 라이브 오버라이드, 최우선 순위)
  - `<PROVIDER>_API_KEYS` (쉼표 또는 세미콜론 목록)
  - `<PROVIDER>_API_KEY` (주 키)
  - `<PROVIDER>_API_KEY_*` (번호가 매겨진 목록, 예: `<PROVIDER>_API_KEY_1`)
- Google 프로바이더의 경우, `GOOGLE_API_KEY`도 대체로 포함됩니다.
- 키 선택 순서는 우선순위를 유지하고 중복 값을 제거합니다.
- 요청은 속도 제한 응답 (예: `429`, `rate_limit`, `quota`, `resource exhausted`)에서만 다음 키로 재시도됩니다.
- 속도 제한이 아닌 실패는 즉시 실패하며, 키 로테이션을 시도하지 않습니다.
- 모든 후보 키가 실패하면, 마지막 시도에서 최종 오류가 반환됩니다.

## 기본 제공 프로바이더 (pi-ai 카탈로그)

OpenClaw는 pi-ai 카탈로그와 함께 제공됩니다. 이 프로바이더는 **설정 필요 없음**
`models.providers` 설정을 필요로 하지 않으며, 인증을 설정하고 모델을 선택하면 됩니다.

### OpenAI

- 프로바이더: `openai`
- 인증: `OPENAI_API_KEY`
- 선택적 로테이션: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, 그리고 `OPENCLAW_LIVE_OPENAI_KEY` (단일 오버라이드)
- 예제 모델: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- 프로바이더: `anthropic`
- 인증: `ANTHROPIC_API_KEY` 또는 `claude setup-token`
- 선택적 로테이션: `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, 그리고 `OPENCLAW_LIVE_ANTHROPIC_KEY` (단일 오버라이드)
- 예제 모델: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token 을 붙여넣습니다) 또는 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 프로바이더: `openai-codex`
- 인증: OAuth (ChatGPT)
- 예제 모델: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` 또는 `openclaw models auth login --provider openai-codex`

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 프로바이더: `opencode`
- 인증: `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`)
- 예제 모델: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API key)

- 프로바이더: `google`
- 인증: `GEMINI_API_KEY`
- 선택적 로테이션: `GEMINI_API_KEYS`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GOOGLE_API_KEY` 대체, 그리고 `OPENCLAW_LIVE_GEMINI_KEY` (단일 오버라이드)
- 예제 모델: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, and Gemini CLI

- 프로바이더: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- 인증: Vertex는 gcloud ADC를 사용하며, Antigravity/Gemini CLI는 해당 인증 흐름을 따릅니다.
- Antigravity OAuth는 번들 플러그인으로 제공됩니다 (`google-antigravity-auth`, 기본적으로 비활성화).
  - 활성화: `openclaw plugins enable google-antigravity-auth`
  - 로그인: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth는 번들 플러그인으로 제공됩니다 (`google-gemini-cli-auth`, 기본적으로 비활성화).
  - 활성화: `openclaw plugins enable google-gemini-cli-auth`
  - 로그인: `openclaw models auth login --provider google-gemini-cli --set-default`
  - 주의: `openclaw.json`에 클라이언트 ID 또는 비밀을 붙여넣을 필요가 없습니다. CLI 로그인 흐름은 게이트웨이 호스트의 인증 프로필에 토큰을 저장합니다.

### Z.AI (GLM)

- 프로바이더: `zai`
- 인증: `ZAI_API_KEY`
- 예제 모델: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - 별칭: `z.ai/*` 및 `z-ai/*`는 `zai/*`로 정규화됩니다.

### Vercel AI 게이트웨이

- 프로바이더: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- 예제 모델: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### 기타 기본 제공 프로바이더

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- 예제 모델: `openrouter/anthropic/claude-sonnet-4-5`
- xAI: `xai` (`XAI_API_KEY`)
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras의 GLM 모델은 `zai-glm-4.7` 및 `zai-glm-4.6` ID를 사용합니다.
  - OpenAI 호환 베이스 URL: `https://api.cerebras.ai/v1`.
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face Inference: `huggingface` (`HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN`) — OpenAI 호환 라우터; 예제 모델: `huggingface/deepseek-ai/DeepSeek-R1`; CLI: `openclaw onboard --auth-choice huggingface-api-key`. [Hugging Face (Inference)](/ko-KR/providers/huggingface) 참조.

## `models.providers`를 통한 프로바이더 (커스텀/기본 URL)

OpenAI/Anthropic 호환 프록시를 추가하려면 `models.providers` (또는 `models.json`)을 사용하세요.

### Moonshot AI (Kimi)

Moonshot은 OpenAI 호환 엔드포인트를 사용하므로, 커스텀 프로바이더로 설정합니다:

- 프로바이더: `moonshot`
- 인증: `MOONSHOT_API_KEY`
- 예제 모델: `moonshot/kimi-k2.5`

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

### Kimi Coding

Kimi Coding은 Moonshot AI의 Anthropic 호환 엔드포인트를 사용합니다:

- 프로바이더: `kimi-coding`
- 인증: `KIMI_API_KEY`
- 예제 모델: `kimi-coding/k2p5`

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: { model: { primary: "kimi-coding/k2p5" } },
  },
}
```

### Qwen OAuth (무료 티어)

Qwen은 디바이스 코드 흐름을 통해 Qwen Coder + Vision에 OAuth 접근을 제공합니다.
번들 플러그인을 활성화한 후 로그인하세요:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

모델 참조:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

설정 세부정보 및 주의사항은 [/providers/qwen](/ko-KR/providers/qwen)를 참조하세요.

### Synthetic

Synthetic은 `synthetic` 프로바이더 뒤에 Anthropic 호환 모델을 제공합니다:

- 프로바이더: `synthetic`
- 인증: `SYNTHETIC_API_KEY`
- 예제 모델: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
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

MiniMax는 커스텀 엔드포인트를 사용하기 때문에 `models.providers`를 통해 구성됩니다:

- MiniMax (Anthropic 호환): `--auth-choice minimax-api`
- 인증: `MINIMAX_API_KEY`

설정 세부정보, 모델 옵션 및 구성 스니펫은 [/providers/minimax](/ko-KR/providers/minimax)를 참조하세요.

### Ollama

Ollama는 OpenAI 호환 API를 제공하는 로컬 LLM 런타임입니다:

- 프로바이더: `ollama`
- 인증: 불필요 (로컬 서버)
- 예제 모델: `ollama/llama3.3`
- 설치: [https://ollama.ai](https://ollama.ai)

```bash
# Ollama를 설치하고, 그런 다음 모델을 가져옵니다:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama는 로컬에서 `http://127.0.0.1:11434/v1`로 실행될 때 자동으로 감지됩니다. 모델 추천 및 사용자 설정 구성에 대해서는 [/providers/ollama](/ko-KR/providers/ollama)를 참조하세요.

### vLLM

vLLM은 로컬 (또는 자체 호스팅) OpenAI 호환 서버입니다:

- 프로바이더: `vllm`
- 인증: 선택 사항 (서버 설정에 따라 다름)
- 기본 베이스 URL: `http://127.0.0.1:8000/v1`

로컬에서 자동 발견에 참여하려면 (서버가 인증을 강제하지 않으면 아무 값이나 작동합니다):

```bash
export VLLM_API_KEY="vllm-local"
```

그런 다음 모델을 설정합니다 (서버가 반환한 `/v1/models` ID 중 하나로 교체합니다):

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

자세한 내용은 [/providers/vllm](/ko-KR/providers/vllm)를 참조하세요.

### 로컬 프록시 (LM Studio, vLLM, LiteLLM 등)

예제 (OpenAI 호환):

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

- 커스텀 프로바이더의 경우 `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`는 선택 사항입니다.
  생략되면 OpenClaw 기본값은 다음과 같습니다:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 추천 설정: 프록시/모델의 제한에 맞는 명시적 값을 설정하세요.

## CLI 예제

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

전체 구성 예제는 [/gateway/configuration](/ko-KR/gateway/configuration)을 참고하세요.