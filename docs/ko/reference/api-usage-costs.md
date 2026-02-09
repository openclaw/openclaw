---
summary: "어떤 항목이 비용을 발생시킬 수 있는지, 어떤 키가 사용되는지, 그리고 사용량을 확인하는 방법을 감사하십시오"
read_when:
  - 유료 API 를 호출할 수 있는 기능이 무엇인지 이해하고 싶을 때
  - 키, 비용, 사용 가시성을 감사해야 합니다
  - /status 또는 /usage 비용 보고를 설명해야 할 때
title: "API 사용량 및 비용"
---

# API 사용량 & 비용

이 문서는 **API 키를 호출할 수 있는 기능**과 그 비용이 어디에 표시되는지를 나열합니다. 제공자 사용량 또는 유료 API 호출을 생성할 수 있는 OpenClaw 기능에 초점을 맞춥니다.

## 비용이 표시되는 위치 (채팅 + CLI)

**세션별 비용 스냅샷**

- `/status` 은 현재 세션 모델, 컨텍스트 사용량, 마지막 응답 토큰을 표시합니다.
- 모델이 **API 키 인증**을 사용하는 경우, `/status` 은 마지막 답변에 대한 **추정 비용**도 표시합니다.

**메시지별 비용 푸터**

- `/usage full` 는 모든 응답에 사용량 푸터를 추가하며, **추정 비용**을 포함합니다 (API 키 전용).
- `/usage tokens` 은 토큰만 표시하며, OAuth 흐름에서는 달러 비용이 숨겨집니다.

**CLI 사용량 창 (프로바이더 할당량)**

- `openclaw status --usage` 및 `openclaw channels list` 는 프로바이더 **사용량 창**을 표시합니다
  (메시지별 비용이 아닌 할당량 스냅샷).

자세한 내용과 예시는 [Token use & costs](/reference/token-use)를 참고하십시오.

## 키가 검색되는 방식

OpenClaw 는 다음 위치에서 자격 증명을 수집할 수 있습니다:

- **인증 프로필** (에이전트별, `auth-profiles.json` 에 저장).
- **환경 변수** (예: `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **설정** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`), 이는 스킬 프로세스 환경으로 키를 내보낼 수 있습니다.

## 키를 소비할 수 있는 기능

### 1. 핵심 모델 응답 (채팅 + 도구)

모든 응답 또는 도구 호출은 **현재 모델 프로바이더** (OpenAI, Anthropic 등)를 사용합니다. 이것이 사용량과 비용의 주요 원천입니다.

가격 설정은 [Models](/providers/models)를, 표시 방식은 [Token use & costs](/reference/token-use)를 참고하십시오.

### 2. 미디어 이해 (오디오/이미지/비디오)

입력 미디어는 응답 실행 전에 요약 또는 전사될 수 있습니다. 이는 모델/프로바이더 API 를 사용합니다.

- 오디오: OpenAI / Groq / Deepgram (키가 존재하면 현재 **자동 활성화**).
- 이미지: OpenAI / Anthropic / Google.
- 비디오: Google.

[Media understanding](/nodes/media-understanding)를 참고하십시오.

### 3. 메모리 임베딩 + 시맨틱 검색

시맨틱 메모리 검색은 원격 프로바이더로 구성된 경우 **임베딩 API** 를 사용합니다:

- `memorySearch.provider = "openai"` → OpenAI 임베딩
- `memorySearch.provider = "gemini"` → Gemini 임베딩
- `memorySearch.provider = "voyage"` → Voyage 임베딩
- 로컬 임베딩이 실패할 경우 원격 프로바이더로의 선택적 폴백

`memorySearch.provider = "local"` 를 사용하면 로컬로 유지할 수 있습니다 (API 사용 없음).

[Memory](/concepts/memory)를 참고하십시오.

### 4. 웹 검색 도구 (Brave / Perplexity via OpenRouter)

`web_search` 은 API 키를 사용하며 사용 요금이 발생할 수 있습니다:

- **Brave Search API**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
- **Perplexity** (OpenRouter 경유): `PERPLEXITY_API_KEY` 또는 `OPENROUTER_API_KEY`

**Brave 무료 티어 (관대함):**

- **월 2,000 요청**
- **초당 1 요청**
- **신용카드 필요** (검증용, 업그레이드하지 않는 한 요금 없음)

[Web tools](/tools/web)를 참고하십시오.

### 5. 웹 가져오기 도구 (Firecrawl)

`web_fetch` 는 API 키가 존재할 때 **Firecrawl** 을 호출할 수 있습니다:

- `FIRECRAWL_API_KEY` 또는 `tools.web.fetch.firecrawl.apiKey`

Firecrawl 이 구성되지 않은 경우, 도구는 직접 가져오기 + 가독성 처리로 폴백합니다 (유료 API 없음).

[Web tools](/tools/web)를 참고하십시오.

### 6. 프로바이더 사용량 스냅샷 (상태/헬스)

일부 상태 명령은 할당량 창 또는 인증 상태를 표시하기 위해 **프로바이더 사용량 엔드포인트** 를 호출합니다.
이는 일반적으로 호출 빈도가 낮지만 여전히 프로바이더 API 를 사용합니다:

- `openclaw status --usage`
- `openclaw models status --json`

[Models CLI](/cli/models)를 참고하십시오.

### 7. 압축 보호 요약

압축 보호 기능은 **현재 모델**을 사용해 세션 기록을 요약할 수 있으며,
실행 시 프로바이더 API 를 호출합니다.

[Session management + compaction](/reference/session-management-compaction)을 참고하십시오.

### 8. 모델 스캔 / 프로브

`openclaw models scan` 은 OpenRouter 모델을 프로브할 수 있으며,
프로빙이 활성화된 경우 `OPENROUTER_API_KEY` 을 사용합니다.

[Models CLI](/cli/models)를 참고하십시오.

### 9. Talk (음성)

Talk 모드는 구성된 경우 **ElevenLabs** 를 호출할 수 있습니다:

- `ELEVENLABS_API_KEY` 또는 `talk.apiKey`

[Talk mode](/nodes/talk)를 참고하십시오.

### 10. Skills (서드파티 API)

Skills 는 `apiKey` 를 `skills.entries.<name>.apiKey` 에 저장할 수 있습니다. 스킬이 해당 키를 외부
API 에 사용하면, 스킬의 프로바이더 정책에 따라 비용이 발생할 수 있습니다.

[Skills](/tools/skills)를 참고하십시오.
