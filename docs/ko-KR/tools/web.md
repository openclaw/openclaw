---
summary: "Web search + fetch tools (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Brave Search API key setup
  - You want to use Perplexity Sonar for web search
title: "Web Tools"
---

# Web tools

OpenClaw는 두 가지 경량 웹 도구를 제공합니다:

- `web_search` — Brave Search API(기본) 또는 Perplexity Sonar(직접 또는 OpenRouter를 통해)를 통해 웹 검색.
- `web_fetch` — HTTP 가져오기 + 읽을 수 있는 추출 (HTML → markdown/텍스트).

이들은 **브라우저 자동화가 아닙니다**. JS가 많은 사이트나 로그인이 필요한 경우 [브라우저 도구](/ko-KR/tools/browser)를 사용하세요.

## 작동 방식

- `web_search`는 구성된 프로바이더를 호출하여 결과를 반환합니다.
  - **Brave** (기본): 구조화된 결과(제목, URL, 요약) 반환.
  - **Perplexity**: 실시간 웹 검색에서 인용과 함께 AI 합성 답변 반환.
- 결과는 쿼리별로 15분간 캐시됩니다(구성 가능).
- `web_fetch`는 단순한 HTTP GET을 수행하여 읽을 수 있는 콘텐츠를 추출합니다 (HTML → markdown/텍스트). JavaScript를 실행하지 않습니다.
- `web_fetch`는 기본적으로 활성화되어 있습니다(명시적으로 비활성화하지 않는 한).

## 검색 프로바이더 선택

| Provider            | Pros                                         | Cons                                     | API Key                                      |
| ------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **Brave** (default) | 빠른 속도, 구조화된 결과, 무료 단계 제공       | 전통적인 검색 결과                       | `BRAVE_API_KEY`                              |
| **Perplexity**      | AI 합성 답변, 인용, 실시간                    | Perplexity 또는 OpenRouter 접근 필요      | `OPENROUTER_API_KEY` 또는 `PERPLEXITY_API_KEY`|

[Brave Search 설정](/ko-KR/brave-search) 및 [Perplexity Sonar](/ko-KR/perplexity)을 통해 프로바이더별 세부정보를 확인하세요.

구성에서 프로바이더를 설정하세요:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // 또는 "perplexity"
      },
    },
  },
}
```

예시: Perplexity Sonar(직접 API)로 전환:

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Brave API 키 가져오기

1. [https://brave.com/search/api/](https://brave.com/search/api/)에서 Brave Search API 계정을 만드세요.
2. 대시보드에서 **Data for Search** 플랜을 선택하고(“Data for AI”가 아님) API 키를 생성하세요.
3. 구성에 키를 저장하려면 `openclaw configure --section web`을 실행하거나 환경 변수에 `BRAVE_API_KEY`를 설정하세요.

Brave는 무료 단계와 유료 플랜을 제공합니다. Brave API 포털에서 현재 제한과 가격을 확인하세요.

### 추천 키 설정 위치

**추천:** `openclaw configure --section web`을 실행합니다. 이는 `tools.web.search.apiKey` 아래 `~/.openclaw/openclaw.json`에 키를 저장합니다.

**환경 대안:** 게이트웨이 프로세스 환경에 `BRAVE_API_KEY`를 설정하세요. 게이트웨이 설치의 경우 `~/.openclaw/.env`(또는 서비스 환경)에 입력합니다. [환경 변수](/ko-KR/help/faq#how-does-openclaw-load-environment-variables)를 참조하세요.

## Perplexity 사용(직접 또는 OpenRouter를 통해)

Perplexity Sonar 모델은 내장 웹 검색 기능을 가지고 있으며, 인용과 함께 AI 합성 답변을 반환합니다. OpenRouter를 통해 사용할 수 있습니다(신용카드 필요 없음 - 암호화/선불 지원).

### OpenRouter API 키 얻기

1. [https://openrouter.ai/](https://openrouter.ai/)에서 계정을 만드세요.
2. 암호화, 선불 또는 신용카드를 사용하여 크레딧을 추가하세요.
3. 계정 설정에서 API 키를 생성하세요.

### Perplexity 검색 설정

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API 키(OPENROUTER_API_KEY 또는 PERPLEXITY_API_KEY가 설정된 경우 생략 가능)
          apiKey: "sk-or-v1-...",
          // 기본 URL(키 인식 기본값, 생략시)
          baseUrl: "https://openrouter.ai/api/v1",
          // 모델(기본값 perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**환경 대안:** 게이트웨이 환경에 `OPENROUTER_API_KEY` 또는 `PERPLEXITY_API_KEY`를 설정하세요. 게이트웨이 설치의 경우 `~/.openclaw/.env`에 입력합니다.

기본 URL이 설정되지 않은 경우, OpenClaw는 API 키 출처에 따라 기본값을 선택합니다:

- `PERPLEXITY_API_KEY` 또는 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 또는 `sk-or-...` → `https://openrouter.ai/api/v1`
- 알 수 없는 키 형식 → OpenRouter (안전한 주석)

### 사용 가능한 Perplexity 모델

| Model                            | Description                          | Best for          |
| -------------------------------- | ------------------------------------ | ----------------- |
| `perplexity/sonar`               | 웹 검색과 함께 빠른 Q&A               | 빠른 조회         |
| `perplexity/sonar-pro` (default) | 웹 검색과 함께 다단계 추론           | 복잡한 질문       |
| `perplexity/sonar-reasoning-pro` | 사고의 연결 분석                      | 심도 있는 연구    |

## web_search

설정된 프로바이더를 사용하여 웹을 검색합니다.

### 요구 사항

- `tools.web.search.enabled`가 `false`가 아니어야 합니다(기본값: 활성화됨).
- 선택한 프로바이더에 대한 API 키:
  - **Brave**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, 또는 `tools.web.search.perplexity.apiKey`

### 구성

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // BRAVE_API_KEY가 설정된 경우 옵션
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### 도구 매개변수

- `query` (필수)
- `count` (1–10; 구성의 기본값)
- `country` (선택 사항): 지역별 결과를 위한 2-글자 국가 코드 (예: "DE", "US", "ALL"). 생략한 경우 Brave는 기본 지역을 선택합니다.
- `search_lang` (선택 사항): 검색 결과의 ISO 언어 코드 (예: "de", "en", "fr")
- `ui_lang` (선택 사항): UI 요소의 ISO 언어 코드
- `freshness` (선택사항): 발견 시간으로 필터링
  - Brave: `pd`, `pw`, `pm`, `py`, 또는 `YYYY-MM-DDtoYYYY-MM-DD`
  - Perplexity: `pd`, `pw`, `pm`, `py`

**예시:**

```javascript
// 독일어 특정 검색
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// 프랑스어 검색과 프랑스어 UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// 최근 결과(지난 주)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

URL을 가져와 읽을 수 있는 콘텐츠를 추출합니다.

### web_fetch 요구 사항

- `tools.web.fetch.enabled`가 `false`가 아니어야 합니다(기본값: 활성화됨).
- 선택적 Firecrawl 대체 항목: `tools.web.fetch.firecrawl.apiKey` 또는 `FIRECRAWL_API_KEY`를 설정하세요.

### web_fetch 구성

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        maxResponseBytes: 2000000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // FIRECRAWL_API_KEY가 설정된 경우 옵션
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch 도구 매개변수

- `url` (필수, http/https만)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 잘라내기)

참고:

- `web_fetch`는 먼저 Readability(주요 콘텐츠 추출)를 사용하고, 후속으로 Firecrawl(구성된 경우)을 사용합니다. 둘 다 실패하면 도구는 오류를 반환합니다.
- Firecrawl 요청은 봇 회피 모드를 사용하고 결과를 기본적으로 캐시합니다.
- `web_fetch`는 Chrome과 유사한 User-Agent와 `Accept-Language`를 기본적으로 보내며, 필요 시 `userAgent`를 재정의할 수 있습니다.
- `web_fetch`는 개인/내부 호스트 이름을 차단하고 리디렉션을 재확인합니다(`maxRedirects`로 제한).
- `maxChars`는 `tools.web.fetch.maxCharsCap`에 고정됩니다.
- `web_fetch`는 다운받은 응답 본문 크기를 `tools.web.fetch.maxResponseBytes`으로 제한한 후 구문 분석합니다; 과도한 응답은 잘리고 경고를 포함합니다.
- `web_fetch`는 최선의 시도로 추출하며, 일부 사이트는 브라우저 도구가 필요할 수 있습니다.
- [Firecrawl](/ko-KR/tools/firecrawl)에서 키 설정 및 서비스 세부 사항을 확인하세요.
- 응답은 반복적인 요청 감소를 위해 캐시됩니다(기본 15분).
- 도구 프로필/허용 목록을 사용하는 경우 `web_search`/`web_fetch` 또는 `group:web`을 추가하세요.
- Brave 키가 없으면, `web_search`는 간단한 설정 힌트를 적은 설명서 링크와 함께 반환합니다.