---
summary: "웹 검색용 Perplexity Sonar 설정"
read_when:
  - "웹 검색에 Perplexity Sonar를 사용하고 싶을 때"
  - "PERPLEXITY_API_KEY가 필요하거나 OpenRouter 설정이 필요할 때"
title: "Perplexity Sonar"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/perplexity.md
  workflow: 15
---

# Perplexity Sonar

OpenClaw는 `web_search` 도구에 Perplexity Sonar를 사용할 수 있습니다. Perplexity의 직접 API 또는 OpenRouter를 통해 연결할 수 있습니다.

## API 옵션

### Perplexity (직접)

- 기본 URL: [https://api.perplexity.ai](https://api.perplexity.ai)
- 환경 변수: `PERPLEXITY_API_KEY`

### OpenRouter (대체)

- 기본 URL: [https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)
- 환경 변수: `OPENROUTER_API_KEY`
- 선불/암호화 크레딧을 지원합니다.

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

`PERPLEXITY_API_KEY`와 `OPENROUTER_API_KEY` 둘 다 설정되면 `tools.web.search.perplexity.baseUrl` (또는 `tools.web.search.perplexity.apiKey`)을 설정하여 명확히 합니다.

기본 URL이 설정되지 않으면 OpenClaw는 API 키 소스를 기반으로 기본값을 선택합니다:

- `PERPLEXITY_API_KEY` 또는 `pplx-...` → 직접 Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` 또는 `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- 알 수 없는 키 포맷 → OpenRouter (안전한 폴백)

## 모델

- `perplexity/sonar` — 빠른 Q&A with 웹 검색
- `perplexity/sonar-pro` (기본값) — 다단계 추론 + 웹 검색
- `perplexity/sonar-reasoning-pro` — 깊은 연구

전체 web_search 구성은 [웹 도구](/tools/web)를 참조하세요.
