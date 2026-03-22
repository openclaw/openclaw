---
summary: "Ollama 를 사용하여 OpenClaw 에서 클라우드 및 로컬 모델 실행하기"
read_when:
  - Ollama 를 통해 클라우드 또는 로컬 모델로 OpenClaw 를 실행하고 싶을 때
  - Ollama 설정 및 구성 안내가 필요할 때
title: "Ollama"
x-i18n:
  source_path: docs/providers/ollama.md
---

# Ollama

Ollama 는 오픈소스 모델을 머신에서 쉽게 실행할 수 있게 해주는 로컬 LLM 런타임입니다. OpenClaw 는 Ollama 의 네이티브 API (`/api/chat`) 와 통합되며, 스트리밍 및 도구 호출을 지원하고, `OLLAMA_API_KEY` (또는 인증 프로필) 로 옵트인하고 명시적 `models.providers.ollama` 항목을 정의하지 않으면 로컬 Ollama 모델을 자동 검색할 수 있습니다.

<Warning>
**원격 Ollama 사용자**: OpenClaw 에서 `/v1` OpenAI 호환 URL (`http://host:11434/v1`) 을 사용하지 마세요. 이렇게 하면 도구 호출이 깨지고 모델이 원시 도구 JSON 을 일반 텍스트로 출력할 수 있습니다. 대신 네이티브 Ollama API URL 을 사용하세요: `baseUrl: "http://host:11434"` (`/v1` 없이).
</Warning>

## 빠른 시작

### 온보딩 (권장)

Ollama 를 설정하는 가장 빠른 방법은 온보딩을 통하는 것입니다:

```bash
openclaw onboard
```

프로바이더 목록에서 **Ollama** 를 선택하세요. 온보딩은:

1. Ollama 인스턴스에 연결할 수 있는 Ollama 기본 URL 을 묻습니다 (기본값 `http://127.0.0.1:11434`).
2. **Cloud + Local** (클라우드 모델과 로컬 모델) 또는 **Local** (로컬 모델만) 을 선택할 수 있게 합니다.
3. **Cloud + Local** 을 선택하고 ollama.com 에 로그인되어 있지 않으면 브라우저 로그인 플로우를 엽니다.
4. 사용 가능한 모델을 검색하고 기본값을 제안합니다.
5. 선택한 모델이 로컬에서 사용할 수 없는 경우 자동으로 풀합니다.

비대화형 모드도 지원됩니다:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --accept-risk
```

선택적으로 사용자 정의 기본 URL 또는 모델을 지정합니다:

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

### 수동 설정

1. Ollama 설치: [https://ollama.com/download](https://ollama.com/download)

2. 로컬 추론을 원하면 로컬 모델을 풀합니다:

```bash
ollama pull glm-4.7-flash
# 또는
ollama pull gpt-oss:20b
# 또는
ollama pull llama3.3
```

3. 클라우드 모델도 원하면 로그인합니다:

```bash
ollama signin
```

4. 온보딩을 실행하고 `Ollama` 를 선택합니다:

```bash
openclaw onboard
```

- `Local`: 로컬 모델만
- `Cloud + Local`: 로컬 모델과 클라우드 모델
- `kimi-k2.5:cloud`, `minimax-m2.5:cloud`, `glm-5:cloud` 같은 클라우드 모델은 로컬 `ollama pull` 이 **필요하지 않습니다**

OpenClaw 는 현재 다음을 제안합니다:

- 로컬 기본값: `glm-4.7-flash`
- 클라우드 기본값: `kimi-k2.5:cloud`, `minimax-m2.5:cloud`, `glm-5:cloud`

5. 수동 설정을 선호하는 경우, Ollama 를 OpenClaw 에 직접 활성화합니다 (어떤 값이든 작동합니다. Ollama 는 실제 키를 요구하지 않습니다):

```bash
# 환경 변수 설정
export OLLAMA_API_KEY="ollama-local"

# 또는 설정 파일에서 구성
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

6. 모델을 검사하거나 전환합니다:

```bash
openclaw models list
openclaw models set ollama/glm-4.7-flash
```

7. 또는 설정에서 기본값을 설정합니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/glm-4.7-flash" },
    },
  },
}
```

## 모델 검색 (암시적 프로바이더)

`OLLAMA_API_KEY` (또는 인증 프로필) 를 설정하고 `models.providers.ollama` 를 **정의하지 않으면**, OpenClaw 는 `http://127.0.0.1:11434` 의 로컬 Ollama 인스턴스에서 모델을 검색합니다:

- `/api/tags` 를 조회합니다
- 사용 가능한 경우 `/api/show` 조회로 `contextWindow` 을 최선의 노력으로 읽습니다
- 모델 이름 휴리스틱 (`r1`, `reasoning`, `think`) 으로 `reasoning` 을 표시합니다
- `maxTokens` 를 OpenClaw 가 사용하는 기본 Ollama 최대 토큰 제한으로 설정합니다
- 모든 비용을 `0` 으로 설정합니다

이렇게 하면 로컬 Ollama 인스턴스와 카탈로그를 정렬하면서 수동 모델 항목을 피할 수 있습니다.

사용 가능한 모델을 확인하려면:

```bash
ollama list
openclaw models list
```

새 모델을 추가하려면 Ollama 로 풀하면 됩니다:

```bash
ollama pull mistral
```

새 모델이 자동으로 검색되어 사용할 수 있게 됩니다.

`models.providers.ollama` 를 명시적으로 설정하면 자동 검색이 건너뛰어지며 모델을 수동으로 정의해야 합니다 (아래 참조).

## 설정

### 기본 설정 (암시적 검색)

Ollama 를 활성화하는 가장 간단한 방법은 환경 변수를 통하는 것입니다:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### 명시적 설정 (수동 모델)

다음과 같은 경우 명시적 설정을 사용합니다:

- Ollama 가 다른 호스트/포트에서 실행 중인 경우.
- 특정 컨텍스트 윈도우 또는 모델 목록을 강제하고 싶은 경우.
- 완전히 수동으로 모델을 정의하고 싶은 경우.

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

`OLLAMA_API_KEY` 가 설정된 경우, 프로바이더 항목에서 `apiKey` 를 생략할 수 있으며 OpenClaw 가 가용성 확인을 위해 채워넣습니다.

### 사용자 정의 기본 URL (명시적 설정)

Ollama 가 다른 호스트나 포트에서 실행 중인 경우 (명시적 설정은 자동 검색을 비활성화하므로 모델을 수동으로 정의하세요):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434", // /v1 없음 - 네이티브 Ollama API URL 사용
        api: "ollama", // 네이티브 도구 호출 동작을 보장하기 위해 명시적으로 설정
      },
    },
  },
}
```

<Warning>
URL 에 `/v1` 을 추가하지 마세요. `/v1` 경로는 도구 호출이 안정적이지 않은 OpenAI 호환 모드를 사용합니다. 경로 접미사 없이 기본 Ollama URL 을 사용하세요.
</Warning>

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

## 클라우드 모델

클라우드 모델을 사용하면 로컬 모델과 함께 클라우드 호스팅 모델 (예: `kimi-k2.5:cloud`, `minimax-m2.5:cloud`, `glm-5:cloud`) 을 실행할 수 있습니다.

클라우드 모델을 사용하려면 설정 중 **Cloud + Local** 모드를 선택하세요. 마법사는 로그인 여부를 확인하고 필요하면 브라우저 로그인 플로우를 엽니다. 인증을 확인할 수 없는 경우 마법사는 로컬 모델 기본값으로 폴백합니다.

[ollama.com/signin](https://ollama.com/signin) 에서 직접 로그인할 수도 있습니다.

## 고급

### 추론 모델

OpenClaw 는 `deepseek-r1`, `reasoning` 또는 `think` 와 같은 이름의 모델을 기본적으로 추론 가능으로 처리합니다:

```bash
ollama pull deepseek-r1:32b
```

### 모델 비용

Ollama 는 무료이며 로컬에서 실행되므로 모든 모델 비용은 $0 으로 설정됩니다.

### 스트리밍 설정

OpenClaw 의 Ollama 통합은 기본적으로 **네이티브 Ollama API** (`/api/chat`) 를 사용하며, 스트리밍과 도구 호출을 동시에 완전히 지원합니다. 특별한 설정이 필요하지 않습니다.

#### 레거시 OpenAI 호환 모드

<Warning>
**도구 호출은 OpenAI 호환 모드에서 안정적이지 않습니다.** 프록시에 OpenAI 형식이 필요하고 네이티브 도구 호출 동작에 의존하지 않는 경우에만 이 모드를 사용하세요.
</Warning>

대신 OpenAI 호환 엔드포인트를 사용해야 하는 경우 (예: OpenAI 형식만 지원하는 프록시 뒤에서), `api: "openai-completions"` 를 명시적으로 설정하세요:

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

이 모드는 스트리밍과 도구 호출을 동시에 지원하지 않을 수 있습니다. 모델 설정에서 `params: { streaming: false }` 로 스트리밍을 비활성화해야 할 수 있습니다.

Ollama 에서 `api: "openai-completions"` 를 사용하면, OpenClaw 는 Ollama 가 4096 컨텍스트 윈도우로 자동 폴백하지 않도록 기본적으로 `options.num_ctx` 를 주입합니다. 프록시/업스트림이 알 수 없는 `options` 필드를 거부하는 경우 이 동작을 비활성화하세요:

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

### 컨텍스트 윈도우

자동 검색된 모델의 경우, OpenClaw 는 사용 가능한 경우 Ollama 가 보고하는 컨텍스트 윈도우를 사용하고, 그렇지 않으면 OpenClaw 가 사용하는 기본 Ollama 컨텍스트 윈도우로 폴백합니다. 명시적 프로바이더 설정에서 `contextWindow` 과 `maxTokens` 를 재정의할 수 있습니다.

## 문제 해결

### Ollama 가 감지되지 않음

Ollama 가 실행 중이고, `OLLAMA_API_KEY` (또는 인증 프로필) 를 설정했으며, 명시적 `models.providers.ollama` 항목을 정의하지 **않았는지** 확인하세요:

```bash
ollama serve
```

API 가 접근 가능한지 확인합니다:

```bash
curl http://localhost:11434/api/tags
```

### 모델을 사용할 수 없음

모델이 목록에 없으면:

- 모델을 로컬로 풀하거나,
- `models.providers.ollama` 에서 모델을 명시적으로 정의하세요.

모델을 추가하려면:

```bash
ollama list  # 설치된 것 확인
ollama pull glm-4.7-flash
ollama pull gpt-oss:20b
ollama pull llama3.3     # 또는 다른 모델
```

### 연결 거부

Ollama 가 올바른 포트에서 실행 중인지 확인하세요:

```bash
# Ollama 가 실행 중인지 확인
ps aux | grep ollama

# 또는 Ollama 재시작
ollama serve
```

## 참조

- [Model Providers](/concepts/model-providers) - 모든 프로바이더 개요
- [Model Selection](/concepts/models) - 모델 선택 방법
- [Configuration](/gateway/configuration) - 전체 설정 참조
