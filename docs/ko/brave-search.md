---
summary: "web_search 를 위한 Brave Search API 설정"
read_when:
  - web_search 에 Brave Search 를 사용하려는 경우
  - BRAVE_API_KEY 또는 요금제 세부 정보가 필요한 경우
title: "Brave Search"
---

# Brave Search API

OpenClaw 는 `web_search` 의 기본 프로바이더로 Brave Search 를 사용합니다.

## API 키 가져오기

1. [https://brave.com/search/api/](https://brave.com/search/api/) 에서 Brave Search API 계정을 생성합니다.
2. 대시보드에서 **Data for Search** 요금제를 선택하고 API 키를 생성합니다.
3. 키를 설정에 저장(권장)하거나 Gateway 환경에서 `BRAVE_API_KEY` 를 설정합니다.

## 설정 예시

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

## 참고 사항

- Data for AI 요금제는 `web_search` 와 **호환되지 않습니다**.
- Brave 는 무료 티어와 유료 요금제를 제공합니다. 현재 제한 사항은 Brave API 포털에서 확인하십시오.

전체 web_search 구성은 [Web tools](/tools/web) 를 참고하십시오.
