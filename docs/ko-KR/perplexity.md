---
summary: "Perplexity Sonar setup for web_search"
read_when:
  - You want to use Perplexity Sonar for web search
  - You need PERPLEXITY_API_KEY or OpenRouter setup
title: "Perplexity Sonar"
x-i18n:
  source_hash: f6c9824ad9bebe389f029d74c2a9ae53ab69572bbe5cc6fbbc9c43741eb8e421
---

# 당혹감 소나

OpenClaw는 `web_search` 도구에 Perplexity Sonar를 사용할 수 있습니다. 연결할 수 있습니다
Perplexity의 직접 API 또는 OpenRouter를 통해.

## API 옵션

### 당혹감(직접)

- 기본 URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- 환경변수 : `PERPLEXITY_API_KEY`

### OpenRouter(대체)

- 기본 URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 환경변수 : `OPENROUTER_API_KEY`
- 선불/암호화폐 크레딧을 지원합니다.

## 구성 예

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

## Brave에서 전환

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

`PERPLEXITY_API_KEY`와 `OPENROUTER_API_KEY`가 모두 설정된 경우
`tools.web.search.perplexity.baseUrl` (또는 `tools.web.search.perplexity.apiKey`)
명확하게 하기 위해.

기본 URL이 설정되지 않은 경우 OpenClaw는 API 키 소스를 기반으로 기본값을 선택합니다.

- `PERPLEXITY_API_KEY` 또는 `pplx-...` → 직접적 혼란 (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` 또는 `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- 알 수 없는 키 형식 → OpenRouter(안전한 대체)

## 모델

- `perplexity/sonar` — 웹 검색을 통한 빠른 Q&A
- `perplexity/sonar-pro` (기본값) — 다단계 추론 + 웹 검색
- `perplexity/sonar-reasoning-pro` — 심층 연구

전체 web_search 구성은 [웹 도구](/tools/web)를 참조하세요.
