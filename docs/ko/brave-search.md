---
read_when:
    - web_search에 Brave Search를 사용하고 싶습니다.
    - BRAVE_API_KEY 또는 계획 세부정보가 필요합니다.
summary: web_search를 위한 Brave Search API 설정
title: 용감한 검색
x-i18n:
    generated_at: "2026-02-08T15:46:06Z"
    model: gtx
    provider: google-translate
    source_hash: 81cd0a13239c13f4cf41d3f7b72ea0810c9e3f9f5a19ffc8955aa1822f726261
    source_path: brave-search.md
    workflow: 15
---

# 용감한 검색 API

OpenClaw는 Brave Search를 기본 공급자로 사용합니다. `web_search`.

## API 키 받기

1. Brave Search API 계정을 만드세요. [https://brave.com/search/api/](https://brave.com/search/api/)
2. 대시보드에서 **검색용 데이터** API 키를 계획하고 생성합니다.
3. 키를 config(권장)에 저장하거나 설정하세요. `BRAVE_API_KEY` 게이트웨이 환경에서.

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

- AI 계획을 위한 데이터는 다음과 같습니다. **~ 아니다** 호환 가능 `web_search`.
- Brave는 무료 등급과 유료 요금제를 제공합니다. 현재 한도는 Brave API 포털에서 확인하세요.

보다 [웹 도구](/tools/web) 전체 web_search 구성의 경우.
