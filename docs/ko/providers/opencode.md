---
summary: "OpenClaw 에서 OpenCode Zen (큐레이션된 모델) 사용"
read_when:
  - 모델 접근을 위해 OpenCode Zen 이 필요할 때
  - 코딩에 친화적인 모델의 큐레이션된 목록이 필요할 때
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen 은 OpenCode 팀이 코딩 에이전트를 위해 추천하는 **큐레이션된 모델 목록**입니다.
이는 API 키와 `opencode` 프로바이더를 사용하는 선택적이고 호스팅된 모델 접근 경로입니다.
Zen 은 현재 베타 상태입니다.

## CLI 설정

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 설정 스니펫

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 참고 사항

- `OPENCODE_ZEN_API_KEY` 또한 지원됩니다.
- Zen 에 로그인하여 결제 정보를 추가한 다음 API 키를 복사합니다.
- OpenCode Zen 은 요청당 과금합니다. 자세한 내용은 OpenCode 대시보드를 확인하십시오.
