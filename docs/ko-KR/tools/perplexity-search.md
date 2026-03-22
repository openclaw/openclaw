---
summary: "web_search 를 위한 Perplexity Search API 및 Sonar/OpenRouter 호환성"
read_when:
  - 웹 검색에 Perplexity Search 를 사용하고 싶을 때
  - PERPLEXITY_API_KEY 또는 OPENROUTER_API_KEY 설정이 필요할 때
title: "Perplexity Search"
x-i18n:
  source_path: docs/tools/perplexity-search.md
---

# Perplexity Search API

OpenClaw 은 Perplexity Search API 를 `web_search` 프로바이더로 지원합니다.
`title`, `url`, `snippet` 필드가 있는 구조화된 결과를 반환합니다.

호환성을 위해 OpenClaw 은 레거시 Perplexity Sonar/OpenRouter 설정도 지원합니다.
`OPENROUTER_API_KEY`를 사용하거나 `plugins.entries.perplexity.config.webSearch.apiKey`에 `sk-or-...` 키를 사용하거나 `plugins.entries.perplexity.config.webSearch.baseUrl` / `model`을 설정하면 프로바이더가 chat-completions 경로로 전환되어 구조화된 Search API 결과 대신 인용이 포함된 AI 합성 답변을 반환합니다.

## Perplexity API 키 받기

1. [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) 에서 Perplexity 계정을 만듭니다
2. 대시보드에서 API 키를 생성합니다
3. 키를 설정에 저장하거나 Gateway 환경에서 `PERPLEXITY_API_KEY`를 설정합니다.

## OpenRouter 호환성

이미 Perplexity Sonar 에 OpenRouter 를 사용 중이라면 `provider: "perplexity"`를 유지하고 Gateway 환경에서 `OPENROUTER_API_KEY`를 설정하거나 `plugins.entries.perplexity.config.webSearch.apiKey`에 `sk-or-...` 키를 저장합니다.

선택적 호환성 컨트롤:

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## 설정 예시

### 네이티브 Perplexity Search API

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

### OpenRouter / Sonar 호환성

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "<openrouter-api-key>",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

## 키 설정 위치

**설정을 통해:** `openclaw configure --section web`을 실행합니다. `~/.openclaw/openclaw.json`의 `plugins.entries.perplexity.config.webSearch.apiKey` 아래에 키를 저장합니다.
이 필드는 SecretRef 객체도 허용합니다.

**환경을 통해:** Gateway 프로세스 환경에서 `PERPLEXITY_API_KEY` 또는 `OPENROUTER_API_KEY`를 설정합니다. Gateway 설치의 경우 `~/.openclaw/.env` (또는 서비스 환경) 에 넣습니다. [환경 변수](/help/faq#how-does-openclaw-load-environment-variables)를 참조하세요.

`provider: "perplexity"`가 구성되어 있고 Perplexity 키 SecretRef 가 환경 폴백 없이 미해결된 경우 시작/리로드가 즉시 실패합니다.

## 도구 파라미터

이 파라미터는 네이티브 Perplexity Search API 경로에 적용됩니다.

| 파라미터              | 설명                                                 |
| --------------------- | ---------------------------------------------------- |
| `query`               | 검색 쿼리 (필수)                                     |
| `count`               | 반환할 결과 수 (1-10, 기본값: 5)                     |
| `country`             | 2 자리 ISO 국가 코드 (예: "US", "DE")                |
| `language`            | ISO 639-1 언어 코드 (예: "en", "de", "fr")           |
| `freshness`           | 시간 필터: `day` (24h), `week`, `month`, 또는 `year` |
| `date_after`          | 이 날짜 이후 게시된 결과만 (YYYY-MM-DD)              |
| `date_before`         | 이 날짜 이전 게시된 결과만 (YYYY-MM-DD)              |
| `domain_filter`       | 도메인 허용/거부 목록 배열 (최대 20)                 |
| `max_tokens`          | 총 콘텐츠 예산 (기본값: 25000, 최대: 1000000)        |
| `max_tokens_per_page` | 페이지당 토큰 제한 (기본값: 2048)                    |

레거시 Sonar/OpenRouter 호환성 경로에서는 `query`와 `freshness`만 지원됩니다.
`country`, `language`, `date_after`, `date_before`, `domain_filter`, `max_tokens`, `max_tokens_per_page`와 같은 Search API 전용 필터는 명시적 오류를 반환합니다.

**예시:**

```javascript
// 국가 및 언어별 검색
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});

// 최근 결과 (지난 주)
await web_search({
  query: "AI news",
  freshness: "week",
});

// 도메인 필터링 (허용 목록)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// 도메인 필터링 (거부 목록 - - 접두사 사용)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});
```

### 도메인 필터 규칙

- 필터당 최대 20 개 도메인
- 동일 요청에서 허용 목록과 거부 목록을 혼합할 수 없음
- 거부 목록 항목에는 `-` 접두사 사용 (예: `["-reddit.com"]`)

## 참고 사항

- Perplexity Search API 는 구조화된 웹 검색 결과 (`title`, `url`, `snippet`) 를 반환합니다
- OpenRouter 또는 명시적 `plugins.entries.perplexity.config.webSearch.baseUrl` / `model`은 호환성을 위해 Perplexity 를 Sonar chat completions 로 다시 전환합니다
- 결과는 기본적으로 15 분 동안 캐시됩니다 (`cacheTtlMinutes`로 구성 가능)

전체 web_search 구성은 [웹 도구](/tools/web)를 참조하세요.
[Perplexity Search API 문서](https://docs.perplexity.ai/docs/search/quickstart)에서 자세한 내용을 확인하세요.
