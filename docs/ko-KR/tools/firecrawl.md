---
summary: "Firecrawl fallback for web_fetch (anti-bot + cached extraction)"
read_when:
  - You want Firecrawl-backed web extraction
  - You need a Firecrawl API key
  - You want anti-bot extraction for web_fetch
title: "Firecrawl"
x-i18n:
  source_hash: 08a7ad45b41af41204e44d2b0be0f980b7184d80d2fa3977339e42a47beb2851
---

# 파이어크롤

OpenClaw는 **Firecrawl**을 `web_fetch`에 대한 대체 추출기로 사용할 수 있습니다. 호스팅입니다
봇 우회 및 캐싱을 지원하는 콘텐츠 추출 서비스입니다.
일반 HTTP 가져오기를 차단하는 JS가 많은 사이트나 페이지가 있습니다.

## API 키 받기

1. Firecrawl 계정을 생성하고 API 키를 생성합니다.
2. config에 저장하거나 게이트웨이 환경에서 `FIRECRAWL_API_KEY`를 설정합니다.

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

참고:

- `firecrawl.enabled` API 키가 있는 경우 기본값은 true입니다.
- `maxAgeMs`는 캐시된 결과가 얼마나 오래되었는지를 제어합니다(ms). 기본값은 2일입니다.

## 스텔스/봇 우회

Firecrawl은 봇 우회를 위한 **프록시 모드** 매개변수(`basic`, `stealth` 또는 `auto`)를 노출합니다.
OpenClaw는 Firecrawl 요청에 항상 `proxy: "auto"`와 `storeInCache: true`를 사용합니다.
프록시가 생략되면 Firecrawl의 기본값은 `auto`입니다. `auto` 기본 시도가 실패하면 스텔스 프록시로 재시도하며 더 많은 크레딧을 사용할 수 있습니다.
기본 스크래핑보다.

## `web_fetch`가 Firecrawl을 사용하는 방법

`web_fetch` 추출 순서:

1. 가독성(로컬)
2. Firecrawl(구성된 경우)
3. 기본 HTML 정리(마지막 대체)

전체 웹 도구 설정은 [웹 도구](/tools/web)를 참조하세요.
