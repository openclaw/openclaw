---
summary: "Run OpenClaw with Ollama (local LLM runtime)"
read_when:
  - You want to run OpenClaw with local models via Ollama
  - You need Ollama setup and configuration guidance
title: "Ollama"
x-i18n:
  source_hash: 61f88017027beb205d9d6de8191e980a58e6c7d79a1f32a8dd38bc48668e0eb7
---

# 올라마

Ollama는 머신에서 오픈 소스 모델을 쉽게 실행할 수 있게 해주는 로컬 LLM 런타임입니다. OpenClaw는 Ollama의 OpenAI 호환 API와 통합되며 `OLLAMA_API_KEY`(또는 인증 프로필)을 선택하고 명시적인 `models.providers.ollama` 항목을 정의하지 않으면 **도구 지원 모델을 자동 검색**할 수 있습니다.

## 빠른 시작

1. 올라마 설치: [https://ollama.ai](https://ollama.ai)

2. 모델을 가져옵니다.

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. OpenClaw용 Ollama를 활성화합니다(모든 값이 작동하며 Ollama에는 실제 키가 필요하지 않음).

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Ollama 모델을 사용하세요.

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## 모델 검색(암시적 공급자)

`OLLAMA_API_KEY`(또는 인증 프로필)을 설정하고 `models.providers.ollama`를 정의하지 **않으면** OpenClaw는 `http://127.0.0.1:11434`의 로컬 Ollama 인스턴스에서 모델을 검색합니다.

- `/api/tags` 및 `/api/show` 쿼리
- `tools` 기능을 보고하는 모델만 유지합니다.
- 모델이 `thinking`를 보고하면 `reasoning`로 표시됩니다.
- 사용 가능한 경우 `model_info["<arch>.context_length"]`에서 `contextWindow`를 읽습니다.
- `maxTokens`를 컨텍스트 창의 10배로 설정합니다.
- 모든 비용을 `0`로 설정합니다.

이렇게 하면 Ollama의 기능에 맞춰 카탈로그를 유지하면서 수동 모델 항목을 피할 수 있습니다.

어떤 모델을 사용할 수 있는지 확인하려면:

```bash
ollama list
openclaw models list
```

새 모델을 추가하려면 Ollama를 사용하여 끌어오기만 하면 됩니다.

```bash
ollama pull mistral
```

새 모델이 자동으로 검색되어 사용할 수 있게 됩니다.

`models.providers.ollama`를 명시적으로 설정하면 자동 검색을 건너뛰고 모델을 수동으로 정의해야 합니다(아래 참조).

## 구성

### 기본 설정(암시적 검색)

Ollama를 활성화하는 가장 간단한 방법은 환경 변수를 사용합니다.

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 명시적 설정(수동 모델)

다음과 같은 경우 명시적 구성을 사용합니다.

- Ollama는 다른 호스트/포트에서 실행됩니다.
- 특정 컨텍스트 창이나 모델 목록을 강제로 적용하고 싶습니다.
- 도구 지원을 보고하지 않는 모델을 포함하려고 합니다.

```json5
{
  models: {
    providers: {
      ollama: {
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
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

`OLLAMA_API_KEY`가 설정된 경우 공급자 항목에서 `apiKey`를 생략할 수 있으며 OpenClaw는 가용성 확인을 위해 이를 채웁니다.

### 사용자 정의 기본 URL(명시적 구성)

Ollama가 다른 호스트 또는 포트에서 실행 중인 경우(명시적 구성은 자동 검색을 비활성화하므로 모델을 수동으로 정의하십시오):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

### 모델 선택

일단 구성되면 모든 Ollama 모델을 사용할 수 있습니다.

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

OpenClaw는 Ollama가 `/api/show`에서 `thinking`를 보고할 때 모델을 추론 가능으로 표시합니다.

```bash
ollama pull deepseek-r1:32b
```

### 모델 비용

Ollama는 무료이며 로컬에서 실행되므로 모든 모델 비용은 $0으로 설정됩니다.

### 스트리밍 구성

Ollama의 응답 형식을 사용하는 기본 SDK의 [알려진 문제](https://github.com/badlogic/pi-mono/issues/1205)로 인해 Ollama 모델의 경우 **스트리밍이 기본적으로 비활성화되어 있습니다**. 이는 도구 지원 모델을 사용할 때 손상된 응답을 방지합니다.

스트리밍이 비활성화되면 응답이 한 번에 모두 전달되므로(비스트리밍 모드) 인터리브된 콘텐츠/추론 델타로 인해 잘못된 출력이 발생하는 문제가 방지됩니다.

#### 스트리밍 다시 활성화(고급)

Ollama에 대한 스트리밍을 다시 활성화하려는 경우(도구 지원 모델에 문제가 발생할 수 있음):

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### 다른 공급자에 대한 스트리밍 비활성화

필요한 경우 모든 공급자에 대해 스트리밍을 비활성화할 수도 있습니다.

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

### 컨텍스트 창

자동 검색된 모델의 경우 OpenClaw는 사용 가능한 경우 Ollama가 보고한 컨텍스트 창을 사용하고, 그렇지 않은 경우 기본값은 `8192`입니다. 명시적 공급자 구성에서 `contextWindow` 및 `maxTokens`를 재정의할 수 있습니다.

## 문제 해결

### 올라마가 감지되지 않음

Ollama가 실행 중인지, `OLLAMA_API_KEY`(또는 인증 프로필)을 설정했는지, 명시적인 `models.providers.ollama` 항목을 정의하지 **않았는지** 확인하세요.

```bash
ollama serve
```

그리고 API에 액세스할 수 있습니다.

```bash
curl http://localhost:11434/api/tags
```

### 사용 가능한 모델이 없습니다.

OpenClaw는 도구 지원을 보고하는 모델만 자동 검색합니다. 해당 모델이 목록에 없으면 다음 중 하나를 수행하세요.

- 도구 지원 모델을 가져오거나
- `models.providers.ollama`에 모델을 명시적으로 정의합니다.

모델을 추가하려면:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### 연결이 거부되었습니다.

Ollama가 올바른 포트에서 실행되고 있는지 확인하세요.

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### 출력의 손상된 응답 또는 도구 이름

Ollama 모델을 사용할 때 도구 이름(예: `sessions_send`, `memory_get`)이 포함된 잘못된 응답이나 조각난 텍스트가 표시되는 경우 이는 스트리밍 응답과 관련된 업스트림 SDK 문제 때문입니다. **이 문제는 Ollama 모델에 대한 스트리밍을 비활성화하여 최신 OpenClaw 버전에서 기본적으로 수정되었습니다**.

스트리밍을 수동으로 활성화했는데 이 문제가 발생하는 경우:

1. Ollama 모델 항목에서 `streaming: true` 구성을 제거하거나
2. Ollama 모델에 대해 `streaming: false`를 명시적으로 설정합니다([스트리밍 구성](#streaming-configuration) 참조).

## 참고 항목

- [모델 제공자](/concepts/model-providers) - 모든 제공자 개요
- [모델 선택](/concepts/models) - 모델 선택 방법
- [구성](/gateway/configuration) - 전체 구성 참조
