---
summary: "OpenClaw 에서 xAI Grok 모델 사용하기"
read_when:
  - OpenClaw 에서 Grok 모델을 사용하고 싶을 때
  - xAI 인증 또는 모델 ID 를 설정하는 중일 때
title: "xAI"
x-i18n:
  source_path: docs/providers/xai.md
---

# xAI

OpenClaw 는 Grok 모델을 위한 번들 `xai` 프로바이더 플러그인을 포함합니다.

## 설정

1. xAI 콘솔에서 API 키를 생성합니다.
2. `XAI_API_KEY` 를 설정하거나 다음을 실행합니다:

```bash
openclaw onboard --auth-choice xai-api-key
```

3. 모델을 선택합니다:

```json5
{
  agents: { defaults: { model: { primary: "xai/grok-4" } } },
}
```

## 현재 번들 모델 카탈로그

OpenClaw 는 이제 다음 xAI 모델 패밀리를 기본 포함합니다:

- `grok-4`, `grok-4-0709`
- `grok-4-fast-reasoning`, `grok-4-fast-non-reasoning`
- `grok-4-1-fast-reasoning`, `grok-4-1-fast-non-reasoning`
- `grok-4.20-reasoning`, `grok-4.20-non-reasoning`
- `grok-code-fast-1`

플러그인은 동일한 API 형태를 따르는 최신 `grok-4*` 및 `grok-code-fast*` ID 도 포워드 해석합니다.

## 웹 검색

번들 `grok` 웹 검색 프로바이더도 `XAI_API_KEY` 를 사용합니다:

```bash
openclaw config set tools.web.search.provider grok
```

## 알려진 제한 사항

- 인증은 현재 API 키만 지원합니다. OpenClaw 에는 아직 xAI OAuth/디바이스 코드 플로우가 없습니다.
- `grok-4.20-multi-agent-experimental-beta-0304` 는 표준 OpenClaw xAI 전송과 다른 업스트림 API 표면이 필요하기 때문에 일반 xAI 프로바이더 경로에서 지원되지 않습니다.
- `x_search` 및 `code_execution` 과 같은 네이티브 xAI 서버 측 도구는 아직 번들 플러그인에서 일급 모델 프로바이더 기능이 아닙니다.

## 참고 사항

- OpenClaw 는 공유 러너 경로에서 xAI 특정 도구 스키마 및 도구 호출 호환성 수정을 자동으로 적용합니다.
- 전체 프로바이더 개요는 [Model providers](/providers/index) 를 참조하세요.
