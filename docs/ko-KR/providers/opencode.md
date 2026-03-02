---
summary: "OpenClaw에서 OpenCode Zen (선택된 모델)을 사용합니다"
read_when:
  - OpenCode Zen for 모델 액세스를 원할 때
  - 코딩 친화적 모델의 선별된 목록을 원할 때
title: "OpenCode Zen"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/opencode.md"
  workflow: 15
---

# OpenCode Zen

OpenCode Zen은 코딩 에이전트를 위해 OpenCode 팀이 권장하는 **모델의 선별된 목록**입니다.
이는 API 키를 사용하고 `opencode` 제공자를 사용하는 선택 사항이며, 호스팅된 모델 액세스 경로입니다.
Zen은 현재 베타 상태입니다.

## CLI 설정

```bash
openclaw onboard --auth-choice opencode-zen
# 또는 비대화형
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 구성 스니펫

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 참고

- `OPENCODE_ZEN_API_KEY`도 지원됩니다.
- Zen에 로그인하고 청구 세부사항을 추가하고 API 키를 복사합니다.
- OpenCode Zen은 요청당 청구합니다. 자세한 내용은 OpenCode 대시보드를 확인합니다.
