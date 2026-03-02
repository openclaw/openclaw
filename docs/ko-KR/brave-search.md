---
summary: "web_search용 Brave Search API 설정"
read_when:
  - "web_search에 Brave Search를 사용하고 싶을 때"
  - "BRAVE_API_KEY가 필요하거나 요금제 세부 사항이 필요할 때"
title: "Brave Search"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/brave-search.md
  workflow: 15
---

# Brave Search API

OpenClaw는 `web_search`에 대한 기본 제공자로 Brave Search를 사용합니다.

## API 키 가져오기

1. [https://brave.com/search/api/](https://brave.com/search/api/)에서 Brave Search API 계정을 만듭니다.
2. 대시보드에서 **검색용 데이터** 요금제를 선택하고 API 키를 생성합니다.
3. 구성에 키를 저장합니다 (권장) 또는 Gateway 환경에서 `BRAVE_API_KEY`를 설정합니다.

## 구성 예

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## 메모

- AI용 데이터 요금제는 `web_search`와 **호환되지 않습니다**.
- Brave는 free tier와 유료 요금제를 제공합니다. 현재 한계는 Brave API 포털을 확인하세요.

전체 web_search 구성은 [웹 도구](/tools/web)를 참조하세요.
