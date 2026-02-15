---
summary: "Brave Search API setup for web_search"
read_when:
  - You want to use Brave Search for web_search
  - You need a BRAVE_API_KEY or plan details
title: "Brave Search"
x-i18n:
  source_hash: 81cd0a13239c13f4cf41d3f7b72ea0810c9e3f9f5a19ffc8955aa1822f726261
---

# 용감한 검색 API

OpenClaw는 Brave Search를 `web_search`의 기본 공급자로 사용합니다.

## API 키 받기

1. [https://brave.com/search/api/](https://brave.com/search/api/)에서 Brave Search API 계정을 생성하세요.
2. 대시보드에서 **검색용 데이터** 계획을 선택하고 API 키를 생성합니다.
3. config에 키를 저장하거나(권장) Gateway 환경에서 `BRAVE_API_KEY`를 설정합니다.

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

- AI 계획용 데이터는 `web_search`와 **호환되지 않습니다**.
- Brave는 무료 등급과 유료 요금제를 제공합니다. 현재 한도는 Brave API 포털에서 확인하세요.

전체 web_search 구성은 [웹 도구](/tools/web)를 참조하세요.
