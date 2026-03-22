---
summary: "OpenClaw 에서 OpenCode Zen 및 Go 카탈로그 사용하기"
read_when:
  - OpenCode 호스팅 모델 액세스를 원할 때
  - Zen 과 Go 카탈로그 중에서 선택하고 싶을 때
title: "OpenCode"
x-i18n:
  source_path: docs/providers/opencode.md
---

# OpenCode

OpenCode 는 OpenClaw 에서 두 개의 호스팅 카탈로그를 노출합니다:

- `opencode/...` **Zen** 카탈로그용
- `opencode-go/...` **Go** 카탈로그용

두 카탈로그 모두 동일한 OpenCode API 키를 사용합니다. OpenClaw 는 업스트림 모델별 라우팅이 올바르게 유지되도록 런타임 프로바이더 ID 를 분리하지만, 온보딩과 문서에서는 하나의 OpenCode 설정으로 취급합니다.

## CLI 설정

### Zen 카탈로그

```bash
openclaw onboard --auth-choice opencode-zen
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

### Go 카탈로그

```bash
openclaw onboard --auth-choice opencode-go
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 설정 스니펫

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 카탈로그

### Zen

- 런타임 프로바이더: `opencode`
- 예제 모델: `opencode/claude-opus-4-6`, `opencode/gpt-5.2`, `opencode/gemini-3-pro`
- 큐레이션된 OpenCode 멀티 모델 프록시를 원할 때 적합

### Go

- 런타임 프로바이더: `opencode-go`
- 예제 모델: `opencode-go/kimi-k2.5`, `opencode-go/glm-5`, `opencode-go/minimax-m2.5`
- OpenCode 호스팅 Kimi/GLM/MiniMax 라인업을 원할 때 적합

## 참고 사항

- `OPENCODE_ZEN_API_KEY` 도 지원됩니다.
- 설정 중 하나의 OpenCode 키를 입력하면 두 런타임 프로바이더에 대한 자격 증명이 저장됩니다.
- OpenCode 에 로그인하고, 결제 정보를 추가하고, API 키를 복사합니다.
- 결제 및 카탈로그 가용성은 OpenCode 대시보드에서 관리됩니다.
