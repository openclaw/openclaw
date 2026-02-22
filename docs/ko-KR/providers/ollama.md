---
summary: "OpenClaw를 Ollama (로컬 LLM 런타임)로 실행하기"
read_when:
  - OpenClaw를 Ollama를 통한 로컬 모델로 실행하려는 경우
  - Ollama 설치 및 설정 가이드를 필요로 하는 경우
title: "Ollama"
---

# Ollama

Ollama는 로컬 LLM 런타임으로, 오픈 소스 모델을 손쉽게 머신에서 실행할 수 있도록 해줍니다. OpenClaw는 Ollama의 네이티브 API (`/api/chat`)와 통합되어 스트리밍 및 도구 호출을 지원하며, `OLLAMA_API_KEY` (또는 인증 프로파일)로 선택하고 명시적인 `models.providers.ollama` 항목을 정의하지 않을 경우 **도구 지원 모델을 자동으로 검색할 수** 있습니다.

## 빠른 시작

1. Ollama 설치: [https://ollama.ai](https://ollama.ai)

2. 모델 가져오기:

```bash
ollama pull gpt-oss:20b
# 또는
ollama pull llama3.3
# 또는
ollama pull qwen2.5-coder:32b
# 또는
ollama pull deepseek-r1:32b
```

3. OpenClaw에서 Ollama 활성화하기 (아무 값이나 설정 가능합니다; Ollama는 실제 키를 필요로 하지 않습니다):

```bash
# 환경 변수 설정
export OLLAMA_API_KEY="ollama-local"

# 또는 설정 파일에서 구성하기
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

## 모델 검색 (암시적 프로바이더)

`OLLAMA_API_KEY` (또는 인증 프로파일)를 설정하고 `models.providers.ollama`를 정의하지 않으면 OpenClaw는 로컬 Ollama 인스턴스에서 모델을 검색합니다: `http://127.0.0.1:11434`

- `/api/tags` 및 `/api/show` 쿼리
- `tools` 기능을 보고하는 모델만 유지
- 모델이 `thinking`을 보고할 때 `reasoning`으로 표시
- 사용 가능한 경우 `model_info["<arch>.context_length"]`에서 `contextWindow`를 읽음
- 컨텍스트 윈도우의 10배로 `maxTokens` 설정
- 모든 비용을 `0`으로 설정

이를 통해 수동 모델 항목 없이도 Ollama의 기능에 맞춘 카탈로그를 유지합니다.

사용 가능한 모델을 보려면 다음 명령어를 사용하세요:

```bash
ollama list
openclaw models list
```

새 모델을 추가하려면 단순히 Ollama로 모델을 가져오세요:

```bash
ollama pull mistral
```

새 모델은 자동으로 발견되어 사용 가능합니다.

`models.providers.ollama`를 명시적으로 설정하면 자동 발견이 건너뛰어지며 모델을 수동으로 정의해야 합니다 (아래 참조).

## 설정

### 기본 설정 (암시적 검색)

Ollama를 활성화하는 가장 간단한 방법은 환경 변수를 통한 것입니다:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 명시적 설정 (수동 모델)

명시적 구성을 사용해야 하는 경우:

- Ollama가 다른 호스트/포트에서 실행 중일 때.
- 특정 컨텍스트 윈도우 또는 모델 목록을 강제하려는 경우.
- 도구 지원을 보고하지 않는 모델을 포함하려는 경우.

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

`OLLAMA_API_KEY`가 설정된 경우, 프로바이더 항목에서 `apiKey`를 생략할 수 있으며 OpenClaw는 가용성 확인을 위해 이를 채웁니다.

### 사용자 정의 기본 URL (명시적 구성)

Ollama가 다른 호스트나 포트에서 실행 중인 경우 (명시적 구성은 자동 발견을 비활성화하므로 모델을 수동으로 정의):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434",
      },
    },
  },
}
```

### 모델 선택

설정이 완료되면 모든 Ollama 모델을 사용할 수 있습니다:

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

### Reasoning 모델

OpenClaw는 Ollama가 `/api/show`에서 `thinking`을 보고할 때 모델을 reasoning 가능한 것으로 표시합니다:

```bash
ollama pull deepseek-r1:32b
```

### 모델 비용

Ollama는 무료로 로컬에서 실행되므로 모든 모델 비용은 $0으로 설정됩니다.

### 스트리밍 설정

OpenClaw의 Ollama 통합은 기본적으로 **네이티브 Ollama API** (`/api/chat`)를 사용하며, 스트리밍 및 도구 호출을 동시에 완전히 지원합니다. 특별한 설정은 필요하지 않습니다.

#### 레거시 OpenAI 호환 모드

프록시 뒤에서 OpenAI 형식만 지원하는 경우와 같이 OpenAI 호환 엔드포인트를 사용해야 한다면, `api: "openai-completions"`을 명시적으로 설정하세요:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

참고: OpenAI 호환 엔드포인트는 스트리밍 + 도구 호출을 동시에 지원하지 않을 수 있습니다. 모델 설정에서 `params: { streaming: false }`로 스트리밍을 비활성화해야 할 수 있습니다.

### 컨텍스트 윈도우

자동으로 발견된 모델의 경우, OpenClaw는 가능하면 Ollama가 보고한 컨텍스트 윈도우를 사용하고, 그렇지 않을 경우 기본값인 `8192`를 사용합니다. 명시적 프로바이더 구성에서 `contextWindow`와 `maxTokens`를 재정의할 수 있습니다.

## 문제 해결

### Ollama가 감지되지 않음

Ollama가 실행 중인지 확인하고 `OLLAMA_API_KEY` (또는 인증 프로파일)를 설정했는지, 명시적 `models.providers.ollama` 항목을 정의하지 않았는지 확인하세요:

```bash
ollama serve
```

API가 접근 가능한지 확인하세요:

```bash
curl http://localhost:11434/api/tags
```

### 사용 가능한 모델이 없음

OpenClaw는 도구 지원을 보고하는 모델만 자동으로 발견합니다. 모델이 목록에 없으면, 다음 두 가지 중 하나를 수행하세요:

- 도구 지원 모델을 가져오거나,
- `models.providers.ollama`에 모델을 명시적으로 정의하세요.

모델을 추가하려면:

```bash
ollama list  # 설치된 항목 확인
ollama pull gpt-oss:20b  # 도구 지원 모델 가져오기
ollama pull llama3.3     # 또는 다른 모델
```

### 연결이 거부됨

Ollama가 올바른 포트에서 실행 중인지 확인하세요:

```bash
# Ollama가 실행 중인지 확인
ps aux | grep ollama

# 또는 Ollama 다시 시작
ollama serve
```

## 관련 문서

- [Model Providers](/ko-KR/concepts/model-providers) - 모든 프로바이더 개요
- [Model Selection](/ko-KR/concepts/models) - 모델 선택 방법
- [Configuration](/ko-KR/gateway/configuration) - 전체 구성 참조
