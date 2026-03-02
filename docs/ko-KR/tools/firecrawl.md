---
summary: "web_fetch 폴백용 Firecrawl (anti-bot + 캐시된 추출)"
read_when:
  - Firecrawl 지원 웹 추출을 원할 때
  - Firecrawl API 키가 필요할 때
  - web_fetch를 위한 anti-bot 추출이 필요할 때
title: "Firecrawl"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/firecrawl.md
workflow: 15
---

# Firecrawl

OpenClaw는 `web_fetch`의 폴백 추출기로 **Firecrawl**을 사용할 수 있습니다. 호스팅된
콘텐츠 추출 서비스로서 봇 우회 및 캐싱을 지원합니다. 이는 JavaScript 헤비 사이트 또는 일반 HTTP 페치를 차단하는 페이지에 도움이 됩니다.

## API 키 얻기

1. Firecrawl 계정을 만들고 API 키를 생성합니다.
2. 구성에 저장하거나 Gateway 환경에서 `FIRECRAWL_API_KEY`를 설정합니다.

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

- `firecrawl.enabled`는 API 키가 있을 때 기본값으로 true입니다.
- `maxAgeMs`는 캐시된 결과가 얼마나 오래될 수 있는지 제어합니다(ms). 기본값은 2일입니다.

## 은폐 / 봇 우회

Firecrawl은 봇 우회를 위해 **프록시 모드** 파라미터를 노출합니다(`basic`, `stealth` 또는 `auto`).
OpenClaw는 항상 Firecrawl 요청에 `proxy: "auto"` 플러스 `storeInCache: true`를 사용합니다.
프록시를 생략하면 Firecrawl은 기본값 `auto`입니다. `auto`는 기본 시도가 실패하면 은폐 프록시로 다시 시도하며, 이는 기본 전용 긁기보다 더 많은 크레딧을 사용할 수 있습니다.

## `web_fetch`에서 Firecrawl을 사용하는 방법

`web_fetch` 추출 순서:

1. Readability(로컬)
2. Firecrawl(구성된 경우)
3. 기본 HTML 정리(마지막 폴백)

전체 웹 도구 설정은 [웹 도구](/tools/web)를 참고합니다.
