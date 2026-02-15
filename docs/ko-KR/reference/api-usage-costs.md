---
summary: "Audit what can spend money, which keys are used, and how to view usage"
read_when:
  - You want to understand which features may call paid APIs
  - You need to audit keys, costs, and usage visibility
  - You’re explaining /status or /usage cost reporting
title: "API Usage and Costs"
x-i18n:
  source_hash: 908bfc17811b8f4b009db1a29ec2a4d76d86e8142f041434a8a784f01702f4c3
---

# API 사용량 및 비용

이 문서에는 **API 키를 호출할 수 있는 기능**과 해당 비용이 표시되는 위치가 나열되어 있습니다. 그것은에 초점을 맞추고
공급자 사용 또는 유료 API 호출을 생성할 수 있는 OpenClaw 기능입니다.

## 비용이 표시되는 위치(채팅 + CLI)

**세션당 비용 개요**

- `/status` 현재 세션 모델, 컨텍스트 사용량 및 마지막 응답 토큰을 보여줍니다.
- 모델이 **API 키 인증**을 사용하는 경우 `/status`에는 마지막 응답에 대한 **예상 비용**도 표시됩니다.

**메시지당 비용 바닥글**

- `/usage full`는 **예상 비용**(API 키만 해당)을 포함하여 모든 답변에 사용법 바닥글을 추가합니다.
- `/usage tokens`는 토큰만 표시합니다. OAuth 흐름은 달러 비용을 숨깁니다.

**CLI 사용 기간(공급자 할당량)**

- `openclaw status --usage` 및 `openclaw channels list` 제공자 **사용 창** 표시
  (메시지당 비용이 아닌 할당량 스냅샷)

자세한 내용과 예시는 [토큰 사용 및 비용](/reference/token-use)을 참조하세요.

## 키를 찾는 방법

OpenClaw는 다음에서 자격 증명을 가져올 수 있습니다.

- **인증 프로필**(에이전트별, `auth-profiles.json`에 저장됨).
- **환경 변수** (예: `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **구성** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- 스킬 프로세스 환경으로 키를 내보낼 수 있는 **스킬** (`skills.entries.<name>.apiKey`)

## 키를 쓸 수 있는 기능

### 1) 핵심 모델 응답(채팅 + 도구)

모든 응답 또는 도구 호출은 **현재 모델 공급자**(OpenAI, Anthropic 등)를 사용합니다. 이것은
사용량 및 비용의 주요 소스입니다.

가격 구성은 [모델](/providers/models)을 참조하고 표시는 [토큰 사용 및 비용](/reference/token-use)을 참조하세요.

### 2) 미디어 이해(오디오/이미지/비디오)

응답이 실행되기 전에 인바운드 미디어를 요약/기록할 수 있습니다. 이는 모델/공급자 API를 사용합니다.

- 오디오: OpenAI / Groq / Deepgram(이제 키가 있으면 **자동 활성화**).
- 이미지: OpenAI / Anthropic / Google.
- 영상: 구글.

[미디어 이해](/nodes/media-understanding)를 참조하세요.

### 3) 메모리 임베딩 + 의미 검색

의미론적 메모리 검색은 원격 공급자에 대해 구성된 경우 **임베딩 API**를 사용합니다.

- `memorySearch.provider = "openai"` → OpenAI 임베딩
- `memorySearch.provider = "gemini"` → Gemini 임베딩
- `memorySearch.provider = "voyage"` → 항해 임베딩
- 로컬 임베딩이 실패할 경우 원격 공급자로 대체(선택적)

`memorySearch.provider = "local"`(API 사용 없음)를 사용하여 로컬로 유지할 수 있습니다.

[메모리](/concepts/memory)를 참조하세요.

### 4) 웹 검색 도구(OpenRouter를 통한 Brave / Perplexity)

`web_search`는 API 키를 사용하며 사용 요금이 발생할 수 있습니다.

- **용감한 검색 API**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
- **복잡성**(OpenRouter를 통해): `PERPLEXITY_API_KEY` 또는 `OPENROUTER_API_KEY`

**Brave 무료 등급(관대함):**

- **요청 2,000건/월**
- **초당 요청 1개**
- 인증을 위해 **신용카드 필요**(업그레이드하지 않으면 요금이 부과되지 않음)

[웹 도구](/tools/web)를 참조하세요.

### 5) 웹 가져오기 도구(Firecrawl)

`web_fetch`는 API 키가 있는 경우 **Firecrawl**을 호출할 수 있습니다.

- `FIRECRAWL_API_KEY` 또는 `tools.web.fetch.firecrawl.apiKey`

Firecrawl이 구성되지 않은 경우 도구는 직접 가져오기 + 가독성(유료 API 없음)으로 대체됩니다.

[웹 도구](/tools/web)를 참조하세요.

### 6) 공급자 사용량 스냅샷(상태/상태)

일부 상태 명령은 **공급자 사용 끝점**을 호출하여 할당량 기간이나 인증 상태를 표시합니다.
이는 일반적으로 적은 양의 호출이지만 여전히 공급자 API에 도달합니다.

- `openclaw status --usage`
- `openclaw models status --json`

[모델 CLI](/cli/models)를 참조하세요.

### 7) 압축 보호 요약

압축 보호 기능은 **현재 모델**을 사용하여 세션 기록을 요약할 수 있습니다.
실행될 때 공급자 API를 호출합니다.

[세션 관리 + 압축](/reference/session-management-compaction)를 참조하세요.

### 8) 모델 스캔/프로브

`openclaw models scan`는 OpenRouter 모델을 조사할 수 있으며 다음과 같은 경우 `OPENROUTER_API_KEY`를 사용합니다.
프로빙이 활성화되었습니다.

[모델 CLI](/cli/models)를 참조하세요.

### 9) 토크(연설)

Talk 모드는 구성된 경우 **ElevenLabs**를 호출할 수 있습니다.

- `ELEVENLABS_API_KEY` 또는 `talk.apiKey`

[대화 모드](/nodes/talk)를 참조하세요.

### 10) 기술(타사 API)

스킬은 `apiKey`를 `skills.entries.<name>.apiKey`에 저장할 수 있습니다. 스킬이 해당 키를 외부용으로 사용하는 경우
API의 경우, 스킬 제공자에 따라 비용이 발생할 수 있습니다.

[스킬](/tools/skills)을 참조하세요.
