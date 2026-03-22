---
title: "Perplexity (프로바이더)"
summary: "Perplexity 웹 검색 프로바이더 설정 (API 키, 검색 모드, 필터링)"
read_when:
  - Perplexity 를 웹 검색 프로바이더로 설정하고 싶을 때
  - Perplexity API 키 또는 OpenRouter 프록시 설정이 필요할 때
x-i18n:
  source_path: docs/providers/perplexity-provider.md
---

# Perplexity (웹 검색 프로바이더)

Perplexity 플러그인은 Perplexity Search API 또는 OpenRouter 를 통한 Perplexity Sonar 를 통해 웹 검색 기능을 제공합니다.

<Note>
이 페이지는 Perplexity **프로바이더** 설정을 다룹니다. Perplexity
**도구** (에이전트가 사용하는 방법) 에 대해서는 [Perplexity tool](/tools/perplexity-search) 을 참조하세요.
</Note>

- 유형: 웹 검색 프로바이더 (모델 프로바이더가 아님)
- 인증: `PERPLEXITY_API_KEY` (직접) 또는 `OPENROUTER_API_KEY` (OpenRouter 를 통해)
- 설정 경로: `plugins.entries.perplexity.config.webSearch.apiKey`

## 빠른 시작

1. API 키를 설정합니다:

```bash
openclaw configure --section web
```

또는 직접 설정합니다:

```bash
openclaw config set plugins.entries.perplexity.config.webSearch.apiKey "pplx-xxxxxxxxxxxx"
```

2. 설정되면 에이전트가 웹 검색에 Perplexity 를 자동으로 사용합니다.

## 검색 모드

플러그인은 API 키 접두사에 따라 전송 방식을 자동 선택합니다:

| 키 접두사 | 전송 방식                      | 기능                                 |
| --------- | ------------------------------ | ------------------------------------ |
| `pplx-`   | 네이티브 Perplexity Search API | 구조화된 결과, 도메인/언어/날짜 필터 |
| `sk-or-`  | OpenRouter (Sonar)             | 인용이 포함된 AI 합성 답변           |

## 네이티브 API 필터링

네이티브 Perplexity API (`pplx-` 키) 를 사용할 때, 검색은 다음을 지원합니다:

- **국가**: 2 자리 국가 코드
- **언어**: ISO 639-1 언어 코드
- **날짜 범위**: day, week, month, year
- **도메인 필터**: 허용/차단 목록 (최대 20 개 도메인)
- **콘텐츠 예산**: `max_tokens`, `max_tokens_per_page`

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `PERPLEXITY_API_KEY` 가 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).
