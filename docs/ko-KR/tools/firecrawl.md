---
summary: "Firecrawl 검색, 스크래핑 및 web_fetch 폴백"
read_when:
  - Firecrawl 기반 웹 추출을 원할 때
  - Firecrawl API 키가 필요할 때
  - Firecrawl 를 web_search 프로바이더로 사용하고 싶을 때
  - web_fetch 를 위한 안티봇 추출을 원할 때
title: "Firecrawl"
x-i18n:
  source_path: docs/tools/firecrawl.md
---

# Firecrawl

OpenClaw 은 **Firecrawl**을 세 가지 방식으로 사용할 수 있습니다:

- `web_search` 프로바이더로
- 명시적 플러그인 도구로: `firecrawl_search` 및 `firecrawl_scrape`
- `web_fetch`의 폴백 추출기로

이것은 봇 우회 및 캐싱을 지원하는 호스팅 추출/검색 서비스로, JS 가 많은 사이트나 일반 HTTP 가져오기를 차단하는 페이지에 도움이 됩니다.

## API 키 받기

1. Firecrawl 계정을 만들고 API 키를 생성합니다.
2. 설정에 저장하거나 Gateway 환경에서 `FIRECRAWL_API_KEY`를 설정합니다.

## Firecrawl 검색 구성

```json5
{
  tools: {
    web: {
      search: {
        provider: "firecrawl",
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "FIRECRAWL_API_KEY_HERE",
            baseUrl: "https://api.firecrawl.dev",
          },
        },
      },
    },
  },
}
```

참고 사항:

- 온보딩 또는 `openclaw configure --section web`에서 Firecrawl 을 선택하면 번들 Firecrawl 플러그인이 자동으로 활성화됩니다.
- Firecrawl 과 함께 `web_search`는 `query` 및 `count`를 지원합니다.
- `sources`, `categories` 또는 결과 스크래핑과 같은 Firecrawl 전용 컨트롤에는 `firecrawl_search`를 사용하세요.

## Firecrawl 스크래핑 + web_fetch 폴백 구성

```json5
{
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
      },
    },
  },
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

- `firecrawl.enabled`는 명시적으로 `false`로 설정하지 않는 한 기본값이 `true`입니다.
- Firecrawl 폴백 시도는 API 키를 사용할 수 있을 때만 실행됩니다 (`tools.web.fetch.firecrawl.apiKey` 또는 `FIRECRAWL_API_KEY`).
- `maxAgeMs`는 캐시된 결과의 최대 경과 시간을 제어합니다 (ms). 기본값은 2 일입니다.

`firecrawl_scrape`는 동일한 `tools.web.fetch.firecrawl.*` 설정 및 환경 변수를 재사용합니다.

## Firecrawl 플러그인 도구

### `firecrawl_search`

일반 `web_search` 대신 Firecrawl 전용 검색 컨트롤을 원할 때 사용합니다.

핵심 파라미터:

- `query`
- `count`
- `sources`
- `categories`
- `scrapeResults`
- `timeoutSeconds`

### `firecrawl_scrape`

일반 `web_fetch`가 약한 JS 가 많거나 봇 보호된 페이지에 사용합니다.

핵심 파라미터:

- `url`
- `extractMode`
- `maxChars`
- `onlyMainContent`
- `maxAgeMs`
- `proxy`
- `storeInCache`
- `timeoutSeconds`

## 스텔스 / 봇 우회

Firecrawl 은 봇 우회를 위한 **프록시 모드** 파라미터를 노출합니다 (`basic`, `stealth`, 또는 `auto`).
OpenClaw 은 Firecrawl 요청에 항상 `proxy: "auto"` + `storeInCache: true`를 사용합니다.
프록시가 생략되면 Firecrawl 은 기본값으로 `auto`를 사용합니다. `auto`는 기본 시도가 실패하면 스텔스 프록시로 재시도하므로, 기본 전용 스크래핑보다 더 많은 크레딧을 사용할 수 있습니다.

## `web_fetch`가 Firecrawl 을 사용하는 방법

`web_fetch` 추출 순서:

1. Readability (로컬)
2. Firecrawl (구성된 경우)
3. 기본 HTML 정리 (마지막 폴백)

전체 웹 도구 설정은 [웹 도구](/tools/web)를 참조하세요.
