---
read_when:
    - Firecrawl 지원 웹 추출을 원합니다.
    - Firecrawl API 키가 필요합니다.
    - web_fetch에 대한 안티봇 추출을 원합니다.
summary: web_fetch에 대한 Firecrawl 대체(안티봇 + 캐시 추출)
title: 파이어 크롤링
x-i18n:
    generated_at: "2026-02-08T16:05:19Z"
    model: gtx
    provider: google-translate
    source_hash: 08a7ad45b41af41204e44d2b0be0f980b7184d80d2fa3977339e42a47beb2851
    source_path: tools/firecrawl.md
    workflow: 15
---

# 파이어 크롤링

OpenClaw는 다음을 사용할 수 있습니다. **파이어 크롤링** 대체 추출기로 `web_fetch`. 호스팅입니다
봇 우회 및 캐싱을 지원하는 콘텐츠 추출 서비스입니다.
일반 HTTP 가져오기를 차단하는 JS가 많은 사이트나 페이지가 있습니다.

## API 키 받기

1. Firecrawl 계정을 만들고 API 키를 생성하세요.
2. 구성 또는 세트에 저장 `FIRECRAWL_API_KEY` 게이트웨이 환경에서.

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

- `firecrawl.enabled` API 키가 있으면 기본값은 true입니다.
- `maxAgeMs` 캐시된 결과가 얼마나 오래되었는지(ms) 제어합니다. 기본값은 2일입니다.

## 스텔스/봇 우회

Firecrawl은 다음을 노출합니다. **프록시 모드** 봇 우회 매개변수(`basic`, `stealth`, 또는 `auto`).
OpenClaw는 항상 다음을 사용합니다. `proxy: "auto"` ...을 더한 `storeInCache: true` Firecrawl 요청의 경우.
프록시가 생략되면 Firecrawl의 기본값은 다음과 같습니다. `auto`. `auto` 기본 시도가 실패하면 스텔스 프록시로 재시도하며 더 많은 크레딧을 사용할 수 있습니다.
기본 스크래핑보다.

## 어떻게 `web_fetch` Firecrawl을 사용합니다.

`web_fetch` 추출 순서:

1. 가독성(로컬)
2. Firecrawl(구성된 경우)
3. 기본 HTML 정리(마지막 대체)

보다 [웹 도구](/tools/web) 전체 웹 도구 설정을 위해.
