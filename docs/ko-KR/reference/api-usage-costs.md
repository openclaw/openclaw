---
summary: "누가 돈을 쓸 수 있는지, 어떤 키가 사용되는지, 사용량을 어떻게 보는지 감사하기"
read_when:
  - 유료 API를 호출할 수 있는 기능을 이해하고 싶을 때
  - 키, 비용 및 사용량 가시성을 감사해야 할 때
  - /status 또는 /usage 비용 보고서를 설명할 때
title: "API 사용 및 비용"
---

# API 사용 및 비용

이 문서는 **API 키를 호출할 수 있는 기능**과 그 비용이 어디에 표시되는지를 나열합니다. OpenClaw 기능에 주목하여 프로바이더 사용량 또는 유료 API 호출을 생성할 수 있습니다.

## 비용이 표시되는 위치 (채팅 + CLI)

**세션별 비용 스냅샷**

- `/status`는 현재 세션 모델, 컨텍스트 사용량, 마지막 응답 토큰을 보여줍니다.
- 모델이 **API 키 인증**을 사용하는 경우, `/status`는 마지막 응답에 대한 **추정 비용**도 보여줍니다.

**메시지별 비용 푸터**

- `/usage full`은 모든 응답에 사용량 푸터를 추가하며, **추정 비용**도 포함됩니다 (API 키만 해당).
- `/usage tokens`는 토큰만 표시하며, OAuth 흐름은 금액 비용을 숨깁니다.

**CLI 사용 창 (프로바이더 쿼터)**

- `openclaw status --usage`와 `openclaw channels list`는 프로바이더 **사용 창**을 보여줍니다
  (쿼터 스냅샷, 메시지별 비용이 아님).

자세한 내용과 예시는 [Token use & costs](/ko-KR/reference/token-use)를 참조하세요.

## 키가 발견되는 방법

OpenClaw는 다음에서 자격 증명을 가져올 수 있습니다:

- **인증 프로필** (에이전트별, `auth-profiles.json`에 저장).
- **환경 변수** (예: `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **설정** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **스킬** (`skills.entries.<name>.apiKey`)은 스킬 프로세스 환경으로 키를 내보낼 수 있습니다.

## 키를 소모할 수 있는 기능들

### 1) 핵심 모델 응답 (채팅 + 도구)

모든 응답 또는 도구 호출은 **현재 모델 프로바이더**를 사용합니다 (OpenAI, Anthropic 등). 이것이 사용량과 비용의 주된 출처입니다.

가격 설정은 [Models](/ko-KR/providers/models)를 참조하고, 디스플레이는 [Token use & costs](/ko-KR/reference/token-use)를 확인하세요.

### 2) 미디어 이해 (오디오/이미지/비디오)

수신 미디어는 응답이 실행되기 전에 요약/전사될 수 있습니다. 이는 모델/프로바이더 API를 사용합니다.

- 오디오: OpenAI / Groq / Deepgram (키가 존재할 때 **자동으로 활성화**).
- 이미지: OpenAI / Anthropic / Google.
- 비디오: Google.

[미디어 이해](/ko-KR/nodes/media-understanding)를 참조하세요.

### 3) 메모리 임베딩 + 시맨틱 검색

시맨틱 메모리 검색은 외부 프로바이더에 대해 구성된 경우 **임베딩 API**를 사용합니다:

- `memorySearch.provider = "openai"` → OpenAI 임베딩
- `memorySearch.provider = "gemini"` → Gemini 임베딩
- `memorySearch.provider = "voyage"` → Voyage 임베딩
- 로컬 임베딩 실패 시 선택적으로 원격 프로바이더로 대체

로컬로 유지하려면 `memorySearch.provider = "local"`을 사용하세요 (API 사용 없음).

자세한 내용은 [Memory](/ko-KR/concepts/memory)를 참조하세요.

### 4) 웹 검색 도구 (Brave / Perplexity via OpenRouter)

`web_search`는 API 키를 사용하며, 사용량 요금이 발생할 수 있습니다:

- **Brave Search API**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
- **Perplexity** (OpenRouter 경유): `PERPLEXITY_API_KEY` 또는 `OPENROUTER_API_KEY`

**Brave 무료 계층 (관대한 조건):**

- **2,000 요청/월**
- **1 요청/초**
- **신용 카드 필요** (업그레이드하지 않으면 요금 없음)

자세한 내용은 [Web tools](/ko-KR/tools/web)를 참조하세요.

### 5) 웹 페치 도구 (Firecrawl)

`web_fetch`는 API 키가 있을 경우 **Firecrawl**를 호출할 수 있습니다:

- `FIRECRAWL_API_KEY` 또는 `tools.web.fetch.firecrawl.apiKey`

Firecrawl이 구성되지 않은 경우, 도구는 직접 페치 + 가독성으로 대체됩니다 (유료 API 없음).

자세한 내용은 [Web tools](/ko-KR/tools/web)를 참조하세요.

### 6) 프로바이더 사용 스냅샷 (상태/건강)

일부 상태 명령어는 **프로바이더 사용 엔드포인트**를 호출하여 쿼터 창이나 인증 상태를 표시합니다.
이것들은 일반적으로 저용량 호출이지만 여전히 프로바이더 API를 호출합니다:

- `openclaw status --usage`
- `openclaw models status --json`

자세한 내용은 [Models CLI](/ko-KR/cli/models)를 참조하세요.

### 7) 압축 보호 요약

압축 보호는 **현재 모델**을 사용하여 세션 기록을 요약할 수 있으며, 실행될 때 프로바이더 API를 호출합니다.

자세한 내용은 [Session management + compaction](/ko-KR/reference/session-management-compaction)를 참조하세요.

### 8) 모델 스캔 / 프로브

`openclaw models scan`는 OpenRouter 모델을 프로빙 할 수 있으며, 프로빙이 활성화되면 `OPENROUTER_API_KEY`를 사용합니다.

자세한 내용은 [Models CLI](/ko-KR/cli/models)를 참조하세요.

### 9) 토크 (음성)

토크 모드는 구성된 경우 **ElevenLabs**를 호출할 수 있습니다:

- `ELEVENLABS_API_KEY` 또는 `talk.apiKey`

자세한 내용은 [Talk mode](/ko-KR/nodes/talk)를 참조하세요.

### 10) 스킬 (서드파티 API)

스킬은 `skills.entries.<name>.apiKey`에 `apiKey`를 저장할 수 있습니다. 스킬이 외부 API에 그 키를 사용할 경우, 스킬의 프로바이더에 따라 비용이 발생할 수 있습니다.

자세한 내용은 [Skills](/ko-KR/tools/skills)를 참조하세요.