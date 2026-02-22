---
summary: "web_fetch 에 대한 Firecrawl 예비 수단 (봇 방지 + 캐시된 추출)"
read_when:
  - Firecrawl 기반 웹 추출을 원할 때
  - Firecrawl API 키가 필요할 때
  - web_fetch 에 대해 봇 방지 추출을 원할 때
title: "Firecrawl"
---

# Firecrawl

OpenClaw 는 `web_fetch` 에 대한 예비 추출기로 **Firecrawl** 을 사용할 수 있습니다. 이것은 봇 우회와 캐싱을 지원하는 호스트된 콘텐츠 추출 서비스로, JS 중심의 사이트나 평범한 HTTP 페치를 차단하는 페이지에서 유용합니다.

## API 키 얻기

1. Firecrawl 계정을 생성하고 API 키를 발급받습니다.
2. 설정에 저장하거나 게이트웨이 환경에서 `FIRECRAWL_API_KEY` 를 설정합니다.

## Firecrawl 설정

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

주의사항:

- API 키가 있을 경우, `firecrawl.enabled` 는 기본값으로 true 입니다.
- `maxAgeMs` 는 캐시된 결과물의 최대 유효 시간을 제어합니다 (밀리초). 기본값은 2일입니다.

## 은폐 / 봇 우회

Firecrawl 은 봇 우회를 위한 **프록시 모드** 파라미터를 제공합니다 (`basic`, `stealth`, 또는 `auto`).
OpenClaw 는 항상 `proxy: "auto"` 및 `storeInCache: true` 를 Firecrawl 요청에 사용합니다.
프록시가 생략되면, Firecrawl 은 기본값으로 `auto` 를 사용합니다. 기본 시도가 실패할 경우, `auto` 는 은폐 프록시로 재시도하며, 이는 기본 스크래핑보다 더 많은 크레딧을 사용할 수 있습니다.

## `web_fetch` 가 Firecrawl 을 사용하는 방법

`web_fetch` 추출 순서:

1. Readability (로컬)
2. Firecrawl (설정된 경우)
3. 기본 HTML 정리 (마지막 예비 수단)

전체 웹 도구 설정은 [Web tools](/tools/web) 를 참고하세요.
