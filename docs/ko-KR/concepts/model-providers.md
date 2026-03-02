---
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/concepts/model-providers.md
workflow: 15
summary: "모델 공급자 개요 및 예제 구성 + CLI 흐름"
read_when:
  - 공급자별 모델 설정 참조가 필요합니다
  - 모델 공급자에 대한 예제 구성이나 CLI 온보딩 명령이 필요합니다
title: "모델 공급자"
---

# 모델 공급자

이 페이지는 **LLM/모델 공급자**(WhatsApp/Telegram 같은 채팅 채널이 아님)에 대해 설명합니다.
모델 선택 규칙은 [/concepts/models](/concepts/models)를 참고하십시오.

## 빠른 규칙

- 모델 참조는 `provider/model` 형식을 사용합니다(예: `opencode/claude-opus-4-6`).
- `agents.defaults.models`를 설정하면 허용 목록이 됩니다.
- CLI 도우미: `openclaw onboard`, `openclaw models list`, `openclaw models set <provider/model>`.

## API 키 로테이션

- 선택된 공급자에 대한 일반적인 공급자 로테이션을 지원합니다.
- 다음을 통해 여러 키를 구성하십시오:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (단일 라이브 오버라이드, 최고 우선순위)
  - `<PROVIDER>_API_KEYS` (쉼표 또는 세미콜론 구분 목록)
  - `<PROVIDER>_API_KEY` (기본 키)
  - `<PROVIDER>_API_KEY_*` (번호가 매겨진 목록, 예: `<PROVIDER>_API_KEY_1`)
- Google 공급자의 경우, `GOOGLE_API_KEY`도 폴백으로 포함됩니다.
- 키 선택 순서는 우선순위를 유지하고 중복된 값을 제거합니다.
- 요청은 속도 제한 응답(예: `429`, `rate_limit`, `quota`, `resource exhausted`)에서만 다음 키로 재시도됩니다.
- 속도 제한이 아닌 실패는 즉시 실패합니다. 키 로테이션이 시도되지 않습니다.
- 모든 후보 키가 실패하면 마지막 시도의 최종 오류가 반환됩니다.

## 내장 공급자 (pi-ai 카탈로그)

OpenClaw는 pi-ai 카탈로그와 함께 제공됩니다. 이 공급자들은 **없음**
`models.providers` 구성이 필요합니다. 인증을 설정하고 모델을 선택하기만 하면 됩니다.

### OpenAI

- 공급자: `openai`
- 인증: `OPENAI_API_KEY`
- 선택사항 로테이션: `OPENAI_API_KEYS`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, 그리고 `OPENCLAW_LIVE_OPENAI_KEY` (단일 오버라이드)
- 예제 모델: `openai/gpt-5.1-codex`
- CLI: `openclaw onboard --auth-choice openai-api-key`
- 기본 전송은 `auto`입니다(WebSocket 우선, SSE 폴백)
- `agents.defaults.models["openai/<model>"].params.transport` (`"sse"`, `"websocket"`, 또는 `"auto"`)를 통해 모델별 오버라이드
- OpenAI Responses WebSocket 워밍은 `params.openaiWsWarmup`을 통해 기본적으로 활성화됩니다(`true`/`false`)

```json5
{
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

### Anthropic

- 공급자: `anthropic`
- 인증: `ANTHROPIC_API_KEY` 또는 `claude setup-token`
- 선택사항 로테이션: `ANTHROPIC_API_KEYS`, `ANTHROPIC_API_KEY_1`, `ANTHROPIC_API_KEY_2`, 그리고 `OPENCLAW_LIVE_ANTHROPIC_KEY` (단일 오버라이드)
- 예제 모델: `anthropic/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice token` (setup-token 붙여넣기) 또는 `openclaw models auth paste-token --provider anthropic`

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### OpenAI Code (Codex)

- 공급자: `openai-codex`
- 인증: OAuth (ChatGPT)
- 예제 모델: `openai-codex/gpt-5.3-codex`
- CLI: `openclaw onboard --auth-choice openai-codex` 또는 `openclaw models auth login --provider openai-codex`
- 기본 전송은 `auto`입니다(WebSocket 우선, SSE 폴백)
- `agents.defaults.models["openai-codex/<model>"].params.transport` (`"sse"`, `"websocket"`, 또는 `"auto"`)를 통해 모델별 오버라이드

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

### OpenCode Zen

- 공급자: `opencode`
- 인증: `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`)
- 예제 모델: `opencode/claude-opus-4-6`
- CLI: `openclaw onboard --auth-choice opencode-zen`

```json5
{
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

### Google Gemini (API 키)

- 공급자: `google`
- 인증: `GEMINI_API_KEY`
- 선택사항 로테이션: `GEMINI_API_KEYS`, `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GOOGLE_API_KEY` 폴백, 그리고 `OPENCLAW_LIVE_GEMINI_KEY` (단일 오버라이드)
- 예제 모델: `google/gemini-3-pro-preview`
- CLI: `openclaw onboard --auth-choice gemini-api-key`

### Google Vertex, Antigravity, 및 Gemini CLI

- 공급자: `google-vertex`, `google-antigravity`, `google-gemini-cli`
- 인증: Vertex는 gcloud ADC를 사용합니다. Antigravity/Gemini CLI는 각각의 인증 흐름을 사용합니다
- 주의: OpenClaw의 Antigravity 및 Gemini CLI OAuth는 공식이 아닌 통합입니다. 일부 사용자는 타사 클라이언트를 사용한 후 Google 계정 제한을 보고했습니다. Google 약관을 검토하고 계속 진행하기로 선택한 경우 중요하지 않은 계정을 사용하십시오.
- Antigravity OAuth는 번들 플러그인(`google-antigravity-auth`, 기본적으로 비활성화됨)으로 제공됩니다.
  - 활성화: `openclaw plugins enable google-antigravity-auth`
  - 로그인: `openclaw models auth login --provider google-antigravity --set-default`
- Gemini CLI OAuth는 번들 플러그인(`google-gemini-cli-auth`, 기본적으로 비활성화됨)으로 제공됩니다.
  - 활성화: `openclaw plugins enable google-gemini-cli-auth`
  - 로그인: `openclaw models auth login --provider google-gemini-cli --set-default`
  - 참고: `openclaw.json`에 클라이언트 ID 또는 암호를 붙여넣을 필요가 **없습니다**. CLI 로그인 흐름은 게이트웨이 호스트의 인증 프로필에 토큰을 저장합니다.

### Z.AI (GLM)

- 공급자: `zai`
- 인증: `ZAI_API_KEY`
- 예제 모델: `zai/glm-4.7`
- CLI: `openclaw onboard --auth-choice zai-api-key`
  - 별칭: `z.ai/*` 및 `z-ai/*`는 `zai/*`로 정규화됩니다

### Vercel AI Gateway

- 공급자: `vercel-ai-gateway`
- 인증: `AI_GATEWAY_API_KEY`
- 예제 모델: `vercel-ai-gateway/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --auth-choice ai-gateway-api-key`

### Kilo Gateway

- 공급자: `kilocode`
- 인증: `KILOCODE_API_KEY`
- 예제 모델: `kilocode/anthropic/claude-opus-4.6`
- CLI: `openclaw onboard --kilocode-api-key <key>`
- 기본 URL: `https://api.kilo.ai/api/gateway/`
- 확장 내장 카탈로그에는 GLM-5 Free, MiniMax M2.5 Free, GPT-5.2, Gemini 3 Pro Preview, Gemini 3 Flash Preview, Grok Code Fast 1, 및 Kimi K2.5가 포함됩니다.

자세한 내용은 [/providers/kilocode](/providers/kilocode)를 참고하십시오.

### 기타 내장 공급자

- OpenRouter: `openrouter` (`OPENROUTER_API_KEY`)
- 예제 모델: `openrouter/anthropic/claude-sonnet-4-5`
- Kilo Gateway: `kilocode` (`KILOCODE_API_KEY`)
- 예제 모델: `kilocode/anthropic/claude-opus-4.6`
- xAI: `xai` (`XAI_API_KEY`)
- Mistral: `mistral` (`MISTRAL_API_KEY`)
- 예제 모델: `mistral/mistral-large-latest`
- CLI: `openclaw onboard --auth-choice mistral-api-key`
- Groq: `groq` (`GROQ_API_KEY`)
- Cerebras: `cerebras` (`CEREBRAS_API_KEY`)
  - Cerebras의 GLM 모델은 ID `zai-glm-4.7` 및 `zai-glm-4.6`을 사용합니다.
  - OpenAI 호환 기본 URL: `https://api.cerebras.ai/v1`.
- GitHub Copilot: `github-copilot` (`COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`)
- Hugging Face Inference: `huggingface` (`HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN`) — OpenAI 호환 라우터. 예제 모델: `huggingface/deepseek-ai/DeepSeek-R1`. CLI: `openclaw onboard --auth-choice huggingface-api-key`. 자세한 내용은 [Hugging Face (Inference)](/providers/huggingface)를 참고하십시오.

## `models.providers`를 통한 공급자 (사용자 정의/기본 URL)

**사용자 정의** 공급자 또는 OpenAI/Anthropic 호환 프록시를 추가하려면 `models.providers` (또는 `models.json`)를 사용하십시오.

### Moonshot AI (Kimi)

Moonshot은 OpenAI 호환 엔드포인트를 사용하므로 사용자 정의 공급자로 구성하십시오:

- 공급자: `moonshot`
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

- 공급자: `kimi-coding`
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

Qwen은 기기 코드 흐름을 통해 Qwen Coder + Vision에 대한 OAuth 액세스를 제공합니다.
번들 플러그인을 활성화한 다음 로그인하십시오:

```bash
openclaw plugins enable qwen-portal-auth
openclaw models auth login --provider qwen-portal --set-default
```

모델 참조:

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

자세한 내용과 참고 사항은 [/providers/qwen](/providers/qwen)을 참고하십시오.

### Volcano Engine (Doubao)

Volcano Engine (火山引擎)은 Doubao 및 기타 모델에 대한 접근을 제공합니다.

- 공급자: `volcengine` (코딩: `volcengine-plan`)
- 인증: `VOLCANO_ENGINE_API_KEY`
- 예제 모델: `volcengine/doubao-seed-1-8-251228`
- CLI: `openclaw onboard --auth-choice volcengine-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "volcengine/doubao-seed-1-8-251228" } },
  },
}
```

사용 가능한 모델:

- `volcengine/doubao-seed-1-8-251228` (Doubao Seed 1.8)
- `volcengine/doubao-seed-code-preview-251028`
- `volcengine/kimi-k2-5-260127` (Kimi K2.5)
- `volcengine/glm-4-7-251222` (GLM 4.7)
- `volcengine/deepseek-v3-2-251201` (DeepSeek V3.2 128K)

코딩 모델 (`volcengine-plan`):

- `volcengine-plan/ark-code-latest`
- `volcengine-plan/doubao-seed-code`
- `volcengine-plan/kimi-k2.5`
- `volcengine-plan/kimi-k2-thinking`
- `volcengine-plan/glm-4.7`

### BytePlus (국제)

BytePlus ARK는 국제 사용자에게 Volcano Engine과 동일한 모델에 대한 액세스를 제공합니다.

- 공급자: `byteplus` (코딩: `byteplus-plan`)
- 인증: `BYTEPLUS_API_KEY`
- 예제 모델: `byteplus/seed-1-8-251228`
- CLI: `openclaw onboard --auth-choice byteplus-api-key`

```json5
{
  agents: {
    defaults: { model: { primary: "byteplus/seed-1-8-251228" } },
  },
}
```

사용 가능한 모델:

- `byteplus/seed-1-8-251228` (Seed 1.8)
- `byteplus/kimi-k2-5-260127` (Kimi K2.5)
- `byteplus/glm-4-7-251222` (GLM 4.7)

코딩 모델 (`byteplus-plan`):

- `byteplus-plan/ark-code-latest`
- `byteplus-plan/doubao-seed-code`
- `byteplus-plan/kimi-k2.5`
- `byteplus-plan/kimi-k2-thinking`
- `byteplus-plan/glm-4.7`

### Synthetic

Synthetic은 `synthetic` 공급자 뒤의 Anthropic 호환 모델을 제공합니다:

- 공급자: `synthetic`
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

MiniMax는 사용자 정의 엔드포인트를 사용하기 때문에 `models.providers`를 통해 구성됩니다:

- MiniMax (Anthropic 호환): `--auth-choice minimax-api`
- 인증: `MINIMAX_API_KEY`

자세한 설정, 모델 옵션, 및 구성 스니펫은 [/providers/minimax](/providers/minimax)를 참고하십시오.

### Ollama

Ollama는 OpenAI 호환 API를 제공하는 로컬 LLM 런타임입니다:

- 공급자: `ollama`
- 인증: 필요 없음 (로컬 서버)
- 예제 모델: `ollama/llama3.3`
- 설치: [https://ollama.ai](https://ollama.ai)

```bash
# Ollama 설치 후 모델 가져오기:
ollama pull llama3.3
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/llama3.3" } },
  },
}
```

Ollama는 `http://127.0.0.1:11434/v1`에서 로컬로 실행할 때 자동으로 감지됩니다. 모델 권장 사항 및 사용자 정의 구성은 [/providers/ollama](/providers/ollama)를 참고하십시오.

### vLLM

vLLM은 로컬(또는 자체 호스팅) OpenAI 호환 서버입니다:

- 공급자: `vllm`
- 인증: 선택사항 (서버에 따라 다름)
- 기본 기본 URL: `http://127.0.0.1:8000/v1`

로컬로 자동 발견을 선택하려면 (서버가 인증을 적용하지 않는 경우 모든 값이 작동함):

```bash
export VLLM_API_KEY="vllm-local"
```

그런 다음 모델을 설정합니다 (반환된 `/v1/models` ID 중 하나로 바꾸기):

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

자세한 내용은 [/providers/vllm](/providers/vllm)를 참고하십시오.

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

- 사용자 정의 공급자의 경우, `reasoning`, `input`, `cost`, `contextWindow`, 및 `maxTokens`는 선택사항입니다.
  생략된 경우, OpenClaw는 다음과 같은 기본값을 사용합니다:
  - `reasoning: false`
  - `input: ["text"]`
  - `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  - `contextWindow: 200000`
  - `maxTokens: 8192`
- 권장: 프록시/모델 한계와 일치하는 명시적 값을 설정합니다.

## CLI 예제

```bash
openclaw onboard --auth-choice opencode-zen
openclaw models set opencode/claude-opus-4-6
openclaw models list
```

또한 참고: 전체 구성 예제는 [/gateway/configuration](/gateway/configuration)를 참고하십시오.
