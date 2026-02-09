---
summary: "web_fetch 를 위한 Firecrawl 폴백(안티 봇 + 캐시된 추출)"
read_when:
  - Firecrawl 기반 웹 추출을 원할 때
  - Firecrawl API 키가 필요할 때
  - web_fetch 를 위한 안티 봇 추출이 필요할 때
title: "Firecrawl"
---

# Firecrawl

OpenClaw 는 `web_fetch` 에 대한 폴백 추출기로 **Firecrawl** 을 사용할 수 있습니다. 이는 호스팅된
콘텐츠 추출 서비스로, 봇 우회와 캐싱을 지원하여 JS 중심 사이트나 일반 HTTP 가져오기를 차단하는 페이지에
도움이 됩니다.

## API 키 가져오기

1. Firecrawl 계정을 생성하고 API 키를 발급합니다.
2. 설정에 저장하거나 Gateway(게이트웨이) 환경에서 `FIRECRAWL_API_KEY` 를 설정합니다.

## Firecrawl 구성

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

참고 사항:

- `firecrawl.enabled` 는 API 키가 존재할 때 기본값이 true 입니다.
- `maxAgeMs` 는 캐시된 결과가 얼마나 오래되었을 수 있는지(ms)를 제어합니다. 기본값은 2일입니다.

## 스텔스 / 봇 우회

Firecrawl 은 봇 우회를 위한 **프록시 모드** 매개변수(`basic`, `stealth`, 또는 `auto`)를 제공합니다.
OpenClaw 는 Firecrawl 요청에 항상 `proxy: "auto"` 와 `storeInCache: true` 를 함께 사용합니다.
프록시가 생략되면 Firecrawl 은 기본값으로 `auto` 를 사용합니다. `auto` 는 기본 시도가 실패할 경우 스텔스 프록시로 재시도하며,
기본 전용 스크래핑보다 더 많은 크레딧을 사용할 수 있습니다.

## `web_fetch` 가 Firecrawl 을 사용하는 방식

`web_fetch` 추출 순서:

1. Readability (로컬)
2. Firecrawl (구성된 경우)
3. 기본 HTML 정리(최종 폴백)

전체 웹 도구 설정은 [Web tools](/tools/web)를 참고하십시오.
