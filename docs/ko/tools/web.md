---
read_when:
    - web_search 또는 web_fetch를 활성화하고 싶습니다.
    - Brave Search API 키 설정이 필요합니다.
    - 웹 검색에 Perplexity Sonar를 사용하고 싶습니다.
summary: 웹 검색 + 가져오기 도구(Brave Search API, Perplexity direct/OpenRouter)
title: 웹 도구
x-i18n:
    generated_at: "2026-02-08T16:08:27Z"
    model: gtx
    provider: google-translate
    source_hash: c2f5e15bc78f09f79dda8d41907b94e104952b3876f43e6000aaba1d8dcecb09
    source_path: tools/web.md
    workflow: 15
---

# 웹 도구

OpenClaw는 두 가지 경량 웹 도구를 제공합니다.

- `web_search` — Brave Search API(기본값) 또는 Perplexity Sonar(직접 또는 OpenRouter를 통해)를 통해 웹을 검색합니다.
- `web_fetch` — HTTP 가져오기 + 읽기 가능한 추출(HTML → 마크다운/텍스트).

이들은 **~ 아니다** 브라우저 자동화. JS가 많은 사이트나 로그인의 경우
[브라우저 도구](/tools/browser).

## 작동 원리

- `web_search` 구성된 공급자를 호출하고 결과를 반환합니다.
  - **용감한** (기본값): 구조화된 결과(제목, URL, 스니펫)를 반환합니다.
  - **당황**: 실시간 웹 검색에서 인용된 답변을 AI 합성 답변으로 반환합니다.
- 결과는 쿼리를 통해 15분 동안 캐시됩니다(구성 가능).
- `web_fetch` 일반 HTTP GET을 수행하고 읽을 수 있는 콘텐츠를 추출합니다.
  (HTML → 마크다운/텍스트). 그렇습니다 **~ 아니다** 자바스크립트를 실행합니다.
- `web_fetch` (명시적으로 비활성화하지 않는 한) 기본적으로 활성화됩니다.

## 검색 공급자 선택

| Provider            | Pros                                         | Cons                                     | API Key                                      |
| ------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| **Brave** (default) | Fast, structured results, free tier          | Traditional search results               | `BRAVE_API_KEY`                              |
| **Perplexity**      | AI-synthesized answers, citations, real-time | Requires Perplexity or OpenRouter access | `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` |

보다 [Brave Search 설정](/brave-search) 그리고 [당혹감 소나](/perplexity) 제공업체별 세부정보를 확인하세요.

구성에서 공급자를 설정합니다.

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

예: Perplexity Sonar(직접 API)로 전환:

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

## Brave API 키 받기

1. Brave Search API 계정을 만드세요. [https://brave.com/search/api/](https://brave.com/search/api/)
2. 대시보드에서 **검색용 데이터** ("AI용 데이터" 아님) 계획하고 API 키를 생성합니다.
3. 달리다 `openclaw configure --section web` 구성에 키를 저장하거나(권장) 설정 `BRAVE_API_KEY` 당신의 환경에서.

Brave는 무료 등급과 유료 요금제를 제공합니다. Brave API 포털에서
현재 한도 및 가격.

### 키 설정 위치(권장)

**권장사항:** 달리다 `openclaw configure --section web`. 키를 다음 위치에 저장합니다.
`~/.openclaw/openclaw.json` 아래에 `tools.web.search.apiKey`.

**환경 대안:** 세트 `BRAVE_API_KEY` 게이트웨이 프로세스에서
환경. 게이트웨이 설치의 경우 `~/.openclaw/.env` (또는 당신의
서비스 환경). 보다 [환경 변수](/help/faq#how-does-openclaw-load-environment-variables).

## Perplexity 사용(직접 또는 OpenRouter를 통해)

Perplexity Sonar 모델에는 웹 검색 기능이 내장되어 있으며 AI 합성 결과를 반환합니다.
인용으로 답변합니다. OpenRouter를 통해 사용할 수 있습니다(신용카드 필요 없음 - 지원)
암호화폐/선불).

### OpenRouter API 키 가져오기

1. 다음에서 계정을 만드세요. [https://openrouter.ai/](https://openrouter.ai/)
2. 크레딧 추가(암호화폐, 선불 또는 신용카드 지원)
3. 계정 설정에서 API 키를 생성하세요

### Perplexity 검색 설정

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**환경 대안:** 세트 `OPENROUTER_API_KEY` 또는 `PERPLEXITY_API_KEY` 게이트웨이에서
환경. 게이트웨이 설치의 경우 `~/.openclaw/.env`.

기본 URL이 설정되지 않은 경우 OpenClaw는 API 키 소스를 기반으로 기본값을 선택합니다.

- `PERPLEXITY_API_KEY` 또는 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 또는 `sk-or-...` → `https://openrouter.ai/api/v1`
- 알 수 없는 키 형식 → OpenRouter(안전한 대체)

### 사용 가능한 Perplexity 모델

| Model                            | Description                          | Best for          |
| -------------------------------- | ------------------------------------ | ----------------- |
| `perplexity/sonar`               | Fast Q&A with web search             | Quick lookups     |
| `perplexity/sonar-pro` (default) | Multi-step reasoning with web search | Complex questions |
| `perplexity/sonar-reasoning-pro` | Chain-of-thought analysis            | Deep research     |

## 웹_검색

구성된 공급자를 사용하여 웹을 검색합니다.

### 요구사항

- `tools.web.search.enabled` 되어서는 안 된다 `false` (기본값: 활성화됨)
- 선택한 공급자의 API 키:
  - **용감한**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
  - **당황**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, 또는 `tools.web.search.perplexity.apiKey`

### 구성

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### 도구 매개변수

- `query` (필수의)
- `count` (1–10; 구성의 기본값)
- `country` (선택 사항): 지역별 결과에 대한 2자리 국가 코드(예: "DE", "US", "ALL"). 생략하면 Brave는 기본 지역을 선택합니다.
- `search_lang` (선택사항): 검색결과에 대한 ISO 언어 코드(예: "de", "en", "fr")
- `ui_lang` (선택): UI 요소에 대한 ISO 언어 코드
- `freshness` (선택 사항, Brave에만 해당): 검색 시간을 기준으로 필터링(`pd`, `pw`, `pm`, `py`, 또는 `YYYY-MM-DDtoYYYY-MM-DD`)

**예:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

URL을 가져오고 읽을 수 있는 콘텐츠를 추출합니다.

### web_fetch 요구 사항

- `tools.web.fetch.enabled` 되어서는 안 된다 `false` (기본값: 활성화됨)
- 선택적 Firecrawl 대체: 설정 `tools.web.fetch.firecrawl.apiKey` 또는 `FIRECRAWL_API_KEY`.

### web_fetch 구성

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
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

- `url` (필수, http/https만 해당)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 잘림)

참고:

- `web_fetch` 가독성(기본 콘텐츠 추출)을 먼저 사용한 다음 Firecrawl(구성된 경우)을 사용합니다. 둘 다 실패하면 도구는 오류를 반환합니다.
- Firecrawl 요청은 기본적으로 봇 우회 모드를 사용하고 결과를 캐시합니다.
- `web_fetch` Chrome과 유사한 User-Agent를 보내고 `Accept-Language` 기본적으로; 보수 `userAgent` 필요한 경우.
- `web_fetch` 개인/내부 호스트 이름을 차단하고 리디렉션을 다시 확인합니다(다음으로 제한). `maxRedirects`).
- `maxChars` 에 고정되어 있습니다 `tools.web.fetch.maxCharsCap`.
- `web_fetch` 최선의 추출입니다. 일부 사이트에는 브라우저 도구가 필요합니다.
- 보다 [파이어 크롤링](/tools/firecrawl) 주요 설정 및 서비스 세부정보를 확인하세요.
- 반복되는 가져오기를 줄이기 위해 응답이 캐시됩니다(기본값 15분).
- 도구 프로필/허용 목록을 사용하는 경우 다음을 추가하세요. `web_search`/`web_fetch` 또는 `group:web`.
- 브레이브 키가 누락된 경우, `web_search` 문서 링크와 함께 짧은 설정 힌트를 반환합니다.
