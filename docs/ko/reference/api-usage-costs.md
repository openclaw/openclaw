---
read_when:
    - 유료 API를 호출할 수 있는 기능을 이해하고 싶습니다.
    - 키, 비용, 사용량 가시성을 감사해야 합니다.
    - /status 또는 /usage 비용 보고를 설명하고 있습니다.
summary: 무엇이 돈을 쓸 수 있는지, 어떤 키가 사용되는지, 사용량을 보는 방법을 감사합니다.
title: API 사용량 및 비용
x-i18n:
    generated_at: "2026-02-08T16:10:21Z"
    model: gtx
    provider: google-translate
    source_hash: 908bfc17811b8f4b009db1a29ec2a4d76d86e8142f041434a8a784f01702f4c3
    source_path: reference/api-usage-costs.md
    workflow: 15
---

# API 사용량 및 비용

이 문서 목록 **API 키를 호출할 수 있는 기능** 비용이 표시되는 위치. 그것은에 초점을 맞추고
공급자 사용 또는 유료 API 호출을 생성할 수 있는 OpenClaw 기능입니다.

## 비용이 표시되는 위치(채팅 + CLI)

**세션당 비용 스냅샷**

- `/status` 현재 세션 모델, 컨텍스트 사용량 및 마지막 응답 토큰을 보여줍니다.
- 모델이 사용하는 경우 **API 키 인증**, `/status` 또한 보여줍니다 **예상 비용** 마지막 답장을 위해.

**메시지당 비용 바닥글**

- `/usage full` 다음을 포함하여 모든 답변에 사용법 바닥글을 추가합니다. **예상 비용** (API 키만 해당)
- `/usage tokens` 토큰만 표시합니다. OAuth 흐름은 달러 비용을 숨깁니다.

**CLI 사용 창(공급자 할당량)**

- `openclaw status --usage` 그리고 `openclaw channels list` 공급자 표시 **사용 기간**
  (메시지당 비용이 아닌 할당량 스냅샷)

보다 [토큰 사용 및 비용](/reference/token-use) 자세한 내용과 예시를 확인하세요.

## 키를 검색하는 방법

OpenClaw는 다음에서 자격 증명을 가져올 수 있습니다.

- **인증 프로필** (에이전트당, 다음에 저장됨 `auth-profiles.json`).
- **환경변수** (예: `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **구성** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`, 
  `memorySearch.*`, `talk.apiKey`).
- **기술** (`skills.entries.<name>.apiKey`) 키를 기술 프로세스 환경으로 내보낼 수 있습니다.

## 키를 사용할 수 있는 기능

### 1) 핵심모델 대응(채팅+도구)

모든 응답 또는 도구 호출은 **현재 모델 제공자** (OpenAI, Anthropic 등). 이것은
사용량 및 비용의 주요 소스입니다.

보다 [모델](/providers/models) 가격 구성 및 [토큰 사용 및 비용](/reference/token-use) 디스플레이용.

### 2) 미디어 이해(오디오/이미지/비디오)

응답이 실행되기 전에 인바운드 미디어를 요약/기록할 수 있습니다. 이는 모델/공급자 API를 사용합니다.

- 오디오: OpenAI / Groq / Deepgram(현재 **자동 활성화** 키가 존재하는 경우).
- 이미지: OpenAI / Anthropic / Google.
- 영상: 구글.

보다 [미디어 이해](/nodes/media-understanding).

### 3) 메모리 임베딩 + 의미 검색

의미기억 검색은 **API 내장** 원격 공급자에 대해 구성된 경우:

- `memorySearch.provider = "openai"` → OpenAI 임베딩
- `memorySearch.provider = "gemini"` → Gemini 임베딩
- `memorySearch.provider = "voyage"` → 항해 임베딩
- 로컬 임베딩이 실패할 경우 원격 공급자로 대체(선택적)

다음을 사용하여 로컬로 유지할 수 있습니다. `memorySearch.provider = "local"` (API 사용 없음).

보다 [메모리](/concepts/memory).

### 4) 웹 검색 도구(OpenRouter를 통한 Brave/Perplexity)

`web_search` API 키를 사용하며 사용 요금이 발생할 수 있습니다.

- **용감한 검색 API**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
- **당황** (OpenRouter를 통해): `PERPLEXITY_API_KEY` 또는 `OPENROUTER_API_KEY`

**Brave 무료 계층(관대함):**

- **요청 2,000개/월**
- **요청 1개/초**
- **신용카드 필요** 확인용(업그레이드하지 않으면 요금이 부과되지 않음)

보다 [웹 도구](/tools/web).

### 5) 웹 가져오기 도구(Firecrawl)

`web_fetch` 전화할 수 있다 **파이어 크롤링** API 키가 있는 경우:

- `FIRECRAWL_API_KEY` 또는 `tools.web.fetch.firecrawl.apiKey`

Firecrawl이 구성되지 않은 경우 도구는 직접 가져오기 + 가독성(유료 API 없음)으로 대체됩니다.

보다 [웹 도구](/tools/web).

### 6) 공급자 사용량 스냅샷(상태/상태)

일부 상태 명령은 다음을 호출합니다. **공급자 사용 끝점** 할당량 창 또는 인증 상태를 표시합니다.
이는 일반적으로 적은 양의 호출이지만 여전히 공급자 API에 도달합니다.

- `openclaw status --usage`
- `openclaw models status --json`

보다 [모델 CLI](/cli/models).

### 7) 압축 보호 장치 요약

압축 보호 기능은 다음을 사용하여 세션 기록을 요약할 수 있습니다. **현재 모델**, 어느
실행될 때 공급자 API를 호출합니다.

보다 [세션 관리 + 압축](/reference/session-management-compaction).

### 8) 모델 스캔/프로브

`openclaw models scan` OpenRouter 모델을 조사하고 사용할 수 있습니다. `OPENROUTER_API_KEY` 언제
프로빙이 활성화되었습니다.

보다 [모델 CLI](/cli/models).

### 9) 토크(연설)

토크 모드를 호출할 수 있습니다 **일레븐랩스** 구성 시:

- `ELEVENLABS_API_KEY` 또는 `talk.apiKey`

보다 [토크 모드](/nodes/talk).

### 10) 기술(타사 API)

스킬 저장 가능 `apiKey` ~에 `skills.entries.<name>.apiKey`. 스킬이 해당 키를 외부용으로 사용하는 경우
API의 경우, 스킬 제공자에 따라 비용이 발생할 수 있습니다.

보다 [기술](/tools/skills).
