---
summary: "Web search + fetch tools (Brave Search API, Perplexity direct/OpenRouter)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Brave Search API key setup
  - You want to use Perplexity Sonar for web search
title: "Web Tools"
x-i18n:
  source_hash: c2f5e15bc78f09f79dda8d41907b94e104952b3876f43e6000aaba1d8dcecb09
---

# 웹 도구

OpenClaw는 두 가지 경량 웹 도구를 제공합니다.

- `web_search` — Brave Search API(기본값) 또는 Perplexity Sonar(직접 또는 OpenRouter를 통해)를 통해 웹을 검색합니다.
- `web_fetch` — HTTP 가져오기 + 읽기 가능한 추출(HTML → 마크다운/텍스트).

이는 브라우저 자동화가 **아닙니다**. JS가 많은 사이트나 로그인의 경우
[브라우저 도구](/tools/browser).

## 작동 방식

- `web_search`는 구성된 공급자를 호출하고 결과를 반환합니다.
  - **Brave**(기본값): 구조화된 결과(제목, URL, 스니펫)를 반환합니다.
  - **Perplexity**: 실시간 웹 검색에서 인용된 답변을 AI 합성 답변으로 반환합니다.
- 결과는 쿼리를 통해 15분 동안 캐시됩니다(구성 가능).
- `web_fetch`는 일반 HTTP GET을 수행하고 읽을 수 있는 콘텐츠를 추출합니다.
  (HTML → 마크다운/텍스트). JavaScript를 실행하지 **않습니다**.
- `web_fetch`는 기본적으로 활성화됩니다(명시적으로 비활성화하지 않는 한).

## 검색 공급자 선택

| 공급자             | 장점                            | 단점                                           | API 키                                         |
| ------------------ | ------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| **Brave** (기본값) | 빠르고 구조화된 결과, 무료 계층 | 기존 검색결과                                  | `BRAVE_API_KEY`                                |
| **당황**           | AI합성 답변, 인용, 실시간       | Perplexity 또는 OpenRouter 액세스가 필요합니다 | `OPENROUTER_API_KEY` 또는 `PERPLEXITY_API_KEY` |

공급자별 세부 정보는 [Brave Search 설정](/brave-search) 및 [Perplexity Sonar](/perplexity)를 참조하세요.

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

1. [https://brave.com/search/api/](https://brave.com/search/api/)에서 Brave Search API 계정을 생성하세요.
2. 대시보드에서 **검색용 데이터** 계획("AI용 데이터" 아님)을 선택하고 API 키를 생성합니다.
3. `openclaw configure --section web`를 실행하여 config에 키를 저장하거나(권장) 환경에 `BRAVE_API_KEY`를 설정합니다.

Brave는 무료 등급과 유료 요금제를 제공합니다. Brave API 포털에서
현재 한도 및 가격.

### 키 설정 위치(권장)

**권장:** `openclaw configure --section web`를 실행하세요. 키를 다음 위치에 저장합니다.
`~/.openclaw/openclaw.json` 아래 `tools.web.search.apiKey`.

**환경 대안:** 게이트웨이 프로세스에서 `BRAVE_API_KEY`를 설정합니다.
환경. 게이트웨이 설치의 경우 `~/.openclaw/.env`(또는
서비스 환경). [환경 변수](/help/faq#how-does-openclaw-load-environment-variables)를 참조하세요.

## Perplexity 사용(직접 또는 OpenRouter를 통해)

Perplexity Sonar 모델에는 웹 검색 기능이 내장되어 있으며 AI 합성 결과를 반환합니다.
인용으로 답변합니다. OpenRouter를 통해 사용할 수 있습니다(신용카드 필요 없음 - 지원)
암호화폐/선불).

### OpenRouter API 키 받기

1. [https://openrouter.ai/](https://openrouter.ai/)에서 계정을 생성하세요.
2. 크레딧 추가(암호화폐, 선불카드, 신용카드 지원)
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

**환경 대안:** 게이트웨이에서 `OPENROUTER_API_KEY` 또는 `PERPLEXITY_API_KEY`를 설정합니다.
환경. 게이트웨이 설치의 경우 `~/.openclaw/.env`에 입력하세요.

기본 URL이 설정되지 않은 경우 OpenClaw는 API 키 소스를 기반으로 기본값을 선택합니다.

- `PERPLEXITY_API_KEY` 또는 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 또는 `sk-or-...` → `https://openrouter.ai/api/v1`
- 알 수 없는 키 형식 → OpenRouter(안전한 대체)

### 사용 가능한 Perplexity 모델

| 모델                             | 설명                       |             |
| -------------------------------- | -------------------------- | ----------- |
| `perplexity/sonar`               | 웹 검색을 통한 빠른 Q&A    | 빠른 조회   |
| `perplexity/sonar-pro` (기본값)  | 웹 검색을 통한 다단계 추론 | 복잡한 질문 |
| `perplexity/sonar-reasoning-pro` | 사고 사슬 분석             | 심층 연구   |

## 웹\_검색

구성된 공급자를 사용하여 웹을 검색합니다.

### 요구사항

- `tools.web.search.enabled`는 `false`가 아니어야 합니다. (기본값: 활성화됨)
- 선택한 공급자의 API 키:
  - **용감한**: `BRAVE_API_KEY` 또는 `tools.web.search.apiKey`
  - **당황**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY` 또는 `tools.web.search.perplexity.apiKey`

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

- `query` (필수)
- `count` (1–10; 구성의 기본값)
- `country` (선택 사항): 지역별 결과에 대한 2자리 국가 코드(예: "DE", "US", "ALL"). 생략하면 Brave는 기본 지역을 선택합니다.
- `search_lang` (선택): 검색 결과에 대한 ISO 언어 코드(예: "de", "en", "fr")
- `ui_lang` (선택): UI 요소에 대한 ISO 언어 코드
- `freshness`(선택 사항, Brave 전용): 발견 시간을 기준으로 필터링(`pd`, `pw`, `pm`, `py` 또는 `YYYY-MM-DDtoYYYY-MM-DD`)

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

## 웹\_페치

URL을 가져오고 읽을 수 있는 콘텐츠를 추출합니다.

### web_fetch 요구 사항

- `tools.web.fetch.enabled`는 `false`가 아니어야 합니다(기본값: 활성화됨)
- 선택적 Firecrawl 대체: `tools.web.fetch.firecrawl.apiKey` 또는 `FIRECRAWL_API_KEY`를 설정합니다.

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

- `url` (필수, http/https에만 해당)
- `extractMode` (`markdown` | `text`)
- `maxChars` (긴 페이지 잘림)

참고:

- `web_fetch`는 가독성(주 콘텐츠 추출)을 먼저 사용한 다음 Firecrawl(구성된 경우)을 사용합니다. 둘 다 실패하면 도구는 오류를 반환합니다.
- Firecrawl 요청은 기본적으로 봇 우회 모드를 사용하고 결과를 캐시합니다.
- `web_fetch`는 기본적으로 Chrome과 유사한 User-Agent와 `Accept-Language`를 보냅니다. 필요한 경우 `userAgent`를 재정의하세요.
- `web_fetch`는 개인/내부 호스트 이름을 차단하고 리디렉션을 다시 확인합니다(`maxRedirects`로 제한).
- `maxChars`는 `tools.web.fetch.maxCharsCap`로 고정됩니다.
- `web_fetch`는 최선의 추출입니다. 일부 사이트에는 브라우저 도구가 필요합니다.
- 주요 설정 및 서비스 내용은 [Firecrawl](/tools/firecrawl)을 참고하세요.
- 반복되는 가져오기를 줄이기 위해 응답이 캐시됩니다(기본값 15분).
- 도구 프로필/허용 목록을 사용하는 경우 `web_search`/`web_fetch` 또는 `group:web`를 추가합니다.
- Brave 키가 누락된 경우 `web_search`는 문서 링크와 함께 짧은 설정 힌트를 반환합니다.
