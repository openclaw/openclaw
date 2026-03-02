---
summary: "Ollama (로컬 LLM 런타임)로 OpenClaw 실행"
read_when:
  - Ollama를 통해 로컬 모델로 OpenClaw를 실행하고 싶을 때
  - Ollama 설정 및 구성 지침이 필요할 때
title: "Ollama"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/ollama.md"
  workflow: 15
---

# Ollama

Ollama는 머신에서 오픈 소스 모델을 쉽게 실행할 수 있도록 하는 로컬 LLM 런타임입니다. OpenClaw는 Ollama의 네이티브 API (`/api/chat`)와 통합되어 스트리밍과 도구 호출을 지원하며 **도구 기능 모델을 자동 발견**할 수 있습니다. `OLLAMA_API_KEY` (또는 인증 프로필)로 옵트인하고 명시적 `models.providers.ollama` 항목을 정의하지 않을 때입니다.

<Warning>
**원격 Ollama 사용자**: OpenAI 호환 URL (`http://host:11434/v1`)을 OpenClaw와 함께 사용하지 마세요. 이는 도구 호출을 중단하고 모델이 원시 도구 JSON을 일반 텍스트로 출력할 수 있습니다. 대신 네이티브 Ollama API URL을 사용합니다: `baseUrl: "http://host:11434"` (`/v1` 없음).
</Warning>

## 빠른 시작

1. Ollama 설치: [https://ollama.ai](https://ollama.ai)

2. 모델을 가져옵니다:

```bash
ollama pull gpt-oss:20b
# 또는
ollama pull llama3.3
# 또는
ollama pull qwen2.5-coder:32b
# 또는
ollama pull deepseek-r1:32b
```

3. OpenClaw에 대해 Ollama를 활성화합니다 (모든 값이 작동합니다. Ollama에는 실제 키가 필요하지 않습니다):

```bash
# 환경 변수 설정
export OLLAMA_API_KEY="ollama-local"

# 또는 구성 파일에서 구성
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollama 모델 사용:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## 모델 발견 (암시적 제공자)

`OLLAMA_API_KEY` (또는 인증 프로필)을 설정하고 **`models.providers.ollama`를 정의하지 않으면** OpenClaw는 `http://127.0.0.1:11434`의 로컬 Ollama 인스턴스에서 모델을 발견합니다:

- `/api/tags` 및 `/api/show` 쿼리
- `tools` 기능을 보고하는 모델만 유지
- 모델이 `thinking`을 보고할 때 `reasoning` 표시
- 사용 가능할 때 `model_info["<arch>.context_length"]`에서 `contextWindow` 읽기
- `maxTokens`을 컨텍스트 창의 10배로 설정
- 모든 비용을 `0`으로 설정

이는 수동 모델 항목을 피하면서 카탈로그를 Ollama의 기능과 정렬된 상태로 유지합니다.

사용 가능한 모델을 보려면:

```bash
ollama list
openclaw models list
```

새 모델을 추가하려면 Ollama에서 가져옵니다:

```bash
ollama pull mistral
```

새 모델은 자동으로 발견되고 사용할 수 있게 됩니다.

명시적으로 `models.providers.ollama`을 설정하면 자동 발견이 건너뛰어지고 모델을 수동으로 정의해야 합니다 (아래 참조).

## 구성

### 기본 설정 (암시적 발견)

Ollama를 활성화하는 가장 간단한 방법은 환경 변수를 통하는 것입니다:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 명시적 설정 (수동 모델)

다음을 사용할 때 명시적 구성을 사용합니다:

- Ollama가 다른 호스트/포트에서 실행됩니다.
- 특정 컨텍스트 창 또는 모델 목록을 강제하고 싶습니다.
- 도구 지원을 보고하지 않는 모델을 포함하고 싶습니다.

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

`OLLAMA_API_KEY`가 설정되어 있으면 제공자 항목에서 `apiKey`를 생략할 수 있고 OpenClaw는 가용성 확인을 위해 채웁니다.

### 사용자 정의 기본 URL (명시적 구성)

Ollama가 다른 호스트 또는 포트에서 실행 중인 경우 (명시적 구성은 자동 발견을 비활성화하므로 모델을 수동으로 정의합니다):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // /v1 없음 - 네이티브 Ollama API URL 사용
        api: "ollama", // 네이티브 도구 호출 동작을 보장하려면 명시적으로 설정
      },
    },
  },
}
```

<Warning>
URL에 `/v1`을 추가하지 마세요. `/v1` 경로는 OpenAI 호환 모드를 사용합니다. 여기서 도구 호출은 신뢰할 수 없습니다. 경로 접미사 없이 기본 Ollama URL을 사용합니다.
</Warning>

### 모델 선택

구성되면 모든 Ollama 모델을 사용할 수 있습니다:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## 고급

### 추론 모델

Ollama가 `/api/show`에서 `thinking`을 보고할 때 OpenClaw는 모델을 추론 기능으로 표시합니다:

```bash
ollama pull deepseek-r1:32b
```

### 모델 비용

Ollama는 무료이고 로컬에서 실행되므로 모든 모델 비용은 $0으로 설정됩니다.

### 스트리밍 구성

OpenClaw의 Ollama 통합은 기본적으로 **네이티브 Ollama API** (`/api/chat`)을 사용하며, 이는 스트리밍과 도구 호출을 동시에 완전히 지원합니다. 특별한 구성이 필요하지 않습니다.

#### 레거시 OpenAI 호환 모드

<Warning>
**도구 호출이 OpenAI 호환 모드에서 신뢰할 수 없습니다.** OpenAI 형식을 지원하고 네이티브 도구 호출 동작에 의존하지 않는 프록시가 필요한 경우에만 이 모드를 사용하세요.
</Warning>

대신 OpenAI 호환 엔드포인트를 사용해야 하는 경우 (예: OpenAI 형식만 지원하는 프록시 뒤에), 명시적으로 `api: "openai-completions"`을 설정합니다:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: true, // 기본값: true
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

이 모드는 스트리밍 + 도구 호출을 동시에 지원하지 않을 수 있습니다. 모델 구성에서 `params: { streaming: false }`로 스트리밍을 비활성화해야 할 수 있습니다.

`api: "openai-completions"`이 Ollama와 함께 사용될 때 OpenClaw는 Ollama가 자동으로 4096 컨텍스트 창으로 폴백하지 않도록 기본적으로 `options.num_ctx`를 주입합니다. 프록시/업스트림이 알려지지 않은 `options` 필드를 거부하는 경우 이 동작을 비활성화합니다:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        injectNumCtxForOpenAICompat: false,
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

### 컨텍스트 창

자동 발견 모델의 경우 OpenClaw는 사용 가능할 때 Ollama가 보고한 컨텍스트 창을 사용합니다. 그렇지 않으면 `8192`로 기본값입니다. 명시적 제공자 구성에서 `contextWindow` 및 `maxTokens`을 재정의할 수 있습니다.

## 문제 해결

### Ollama가 감지되지 않음

Ollama가 실행 중이고 `OLLAMA_API_KEY` (또는 인증 프로필)을 설정했으며 **명시적 `models.providers.ollama` 항목을 정의하지 않았는지** 확인합니다:

```bash
ollama serve
```

API가 액세스 가능한지 확인합니다:

```bash
curl http://localhost:11434/api/tags
```

### 사용 가능한 모델 없음

OpenClaw는 도구 지원을 보고하는 모델만 자동 발견합니다. 모델이 나열되지 않으면 다음 중 하나를 수행합니다:

- 도구 기능 모델을 가져옵니다, 또는
- `models.providers.ollama`에서 모델을 명시적으로 정의합니다.

모델을 추가하려면:

```bash
ollama list  # 설치된 항목 확인
ollama pull gpt-oss:20b  # 도구 기능 모델 가져오기
ollama pull llama3.3     # 또는 다른 모델
```

### 연결 거부됨

Ollama가 올바른 포트에서 실행 중인지 확인합니다:

```bash
# Ollama가 실행 중인지 확인
ps aux | grep ollama

# 또는 Ollama 다시 시작
ollama serve
```

## 참고: 도움말

- [모델 제공자](/concepts/model-providers) - 모든 제공자 개요
- [모델 선택](/concepts/models) - 모델 선택 방법
- [구성](/gateway/configuration) - 전체 구성 참조
