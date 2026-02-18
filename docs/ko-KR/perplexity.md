````markdown
---
summary: "웹 검색을 위한 Perplexity Sonar 설정"
read_when:
  - 웹 검색을 위해 Perplexity Sonar를 사용하고 싶을 때
  - PERPLEXITY_API_KEY 또는 OpenRouter 설정이 필요할 때
title: "Perplexity Sonar"
---

# Perplexity Sonar

OpenClaw는 `web_search` 도구에 Perplexity Sonar를 사용할 수 있습니다. Perplexity의 직접 API를 통해 연결하거나 OpenRouter를 통해 연결할 수 있습니다.

## API 옵션

### Perplexity (직접 연결)

- 기본 URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- 환경 변수: `PERPLEXITY_API_KEY`

### OpenRouter (대안)

- 기본 URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 환경 변수: `OPENROUTER_API_KEY`
- 선불/암호화폐 크레딧 지원.

## 설정 예시

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
````

## Brave에서 전환하기

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

`PERPLEXITY_API_KEY`와 `OPENROUTER_API_KEY`가 모두 설정되어 있는 경우, `tools.web.search.perplexity.baseUrl` (또는 `tools.web.search.perplexity.apiKey`)을 설정하여 명확히 하십시오.

기본 URL이 설정되지 않은 경우, OpenClaw는 API 키 소스에 따라 기본값을 선택합니다:

- `PERPLEXITY_API_KEY` 또는 `pplx-...` → 직접 Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` 또는 `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- 알 수 없는 키 형식 → OpenRouter (안전한 대체)

## 모델

- `perplexity/sonar` — 웹 검색으로 빠른 질의응답
- `perplexity/sonar-pro` (기본값) — 다단계 추론 + 웹 검색
- `perplexity/sonar-reasoning-pro` — 심층 연구

전체 웹 검색 구성을 위해 [웹 도구](/tools/web)를 참조하십시오.

```

```
