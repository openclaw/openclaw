---
summary: "공유 OpenCode 설정과 함께 OpenCode Go 카탈로그 사용하기"
read_when:
  - OpenCode Go 카탈로그를 원할 때
  - Go 호스팅 모델의 런타임 모델 참조가 필요할 때
title: "OpenCode Go"
x-i18n:
  source_path: docs/providers/opencode-go.md
---

# OpenCode Go

OpenCode Go 는 [OpenCode](/providers/opencode) 내의 Go 카탈로그입니다.
Zen 카탈로그와 동일한 `OPENCODE_API_KEY` 를 사용하지만, 업스트림 모델별 라우팅이 올바르게 유지되도록 런타임 프로바이더 ID 를 `opencode-go` 로 유지합니다.

## 지원되는 모델

- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

## CLI 설정

```bash
openclaw onboard --auth-choice opencode-go
# 또는 비대화형으로
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 설정 스니펫

```json5
{
  env: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.5" } } },
}
```

## 라우팅 동작

모델 참조가 `opencode-go/...` 를 사용할 때 OpenClaw 는 모델별 라우팅을 자동으로 처리합니다.

## 참고 사항

- 공유 온보딩 및 카탈로그 개요는 [OpenCode](/providers/opencode) 를 사용하세요.
- 런타임 참조는 명시적으로 유지됩니다: Zen 은 `opencode/...`, Go 는 `opencode-go/...`.
