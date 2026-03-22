---
summary: "web_search 를 위한 Brave Search API 설정"
read_when:
  - web_search 에 Brave Search 를 사용하고 싶을 때
  - BRAVE_API_KEY 또는 플랜 세부 사항이 필요할 때
title: "Brave Search"
x-i18n:
  source_path: docs/tools/brave-search.md
---

# Brave Search API

OpenClaw 은 Brave Search API 를 `web_search` 프로바이더로 지원합니다.

## API 키 받기

1. [https://brave.com/search/api/](https://brave.com/search/api/) 에서 Brave Search API 계정을 생성합니다
2. 대시보드에서 **Search** 플랜을 선택하고 API 키를 생성합니다.
3. 키를 설정에 저장하거나 Gateway 환경에서 `BRAVE_API_KEY`를 설정합니다.

## 설정 예시

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "BRAVE_API_KEY_HERE",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "brave",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

프로바이더별 Brave 검색 설정은 이제 `plugins.entries.brave.config.webSearch.*` 아래에 있습니다.
레거시 `tools.web.search.apiKey`는 호환성 심을 통해 여전히 로드되지만, 더 이상 기본 설정 경로가 아닙니다.

## 도구 파라미터

| 파라미터      | 설명                                                     |
| ------------- | -------------------------------------------------------- |
| `query`       | 검색 쿼리 (필수)                                         |
| `count`       | 반환할 결과 수 (1-10, 기본값: 5)                         |
| `country`     | 2 자리 ISO 국가 코드 (예: "US", "DE")                    |
| `language`    | 검색 결과용 ISO 639-1 언어 코드 (예: "en", "de", "fr")   |
| `ui_lang`     | UI 요소용 ISO 언어 코드                                  |
| `freshness`   | 시간 필터: `day` (24 시간), `week`, `month`, 또는 `year` |
| `date_after`  | 이 날짜 이후에 게시된 결과만 (YYYY-MM-DD)                |
| `date_before` | 이 날짜 이전에 게시된 결과만 (YYYY-MM-DD)                |

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

// 날짜 범위 검색
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## 참고 사항

- OpenClaw 은 Brave **Search** 플랜을 사용합니다. 레거시 구독 (예: 월 2,000 쿼리의 원래 무료 플랜) 이 있는 경우 유효하지만 LLM Context 또는 더 높은 속도 제한과 같은 최신 기능은 포함되지 않습니다.
- 각 Brave 플랜에는 **월 $5 무료 크레딧** (갱신) 이 포함됩니다. Search 플랜은 요청 1,000 건당 $5 이므로 크레딧으로 월 1,000 건의 쿼리를 커버합니다. 예상치 못한 요금을 방지하려면 Brave 대시보드에서 사용량 제한을 설정하세요. 현재 플랜은 [Brave API 포털](https://brave.com/search/api/)을 참조하세요.
- Search 플랜에는 LLM Context 엔드포인트 및 AI 추론 권한이 포함됩니다. 모델 학습이나 튜닝을 위해 결과를 저장하려면 명시적 저장 권한이 있는 플랜이 필요합니다. Brave [서비스 약관](https://api-dashboard.search.brave.com/terms-of-service)을 참조하세요.
- 결과는 기본적으로 15 분 동안 캐시됩니다 (`cacheTtlMinutes`로 구성 가능).

전체 web_search 구성은 [웹 도구](/tools/web)를 참조하세요.
