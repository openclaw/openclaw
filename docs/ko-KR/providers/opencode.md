---
summary: "OpenClaw 와 함께 OpenCode Zen (추천 모델)을 사용하세요"
read_when:
  - 모델 액세스를 위해 OpenCode Zen 을 원할 때
  - 코딩 친화적인 추천 모델 목록을 원할 때
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen 은 OpenCode 팀이 코딩 에이전트를 위해 추천하는 **모델의 추천 목록**입니다.
이것은 API 키와 `opencode` 프로바이더를 사용하는 선택적 호스팅 모델 액세스 경로입니다.
Zen 은 현재 베타 버전입니다.

## CLI 설정

```bash
openclaw onboard --auth-choice opencode-zen
# 또는 비대화식
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 설정 코드 스니펫

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 참고 사항

- `OPENCODE_ZEN_API_KEY` 도 지원됩니다.
- Zen 에 로그인하고, 결제 정보를 추가하고, API 키를 복사합니다.
- OpenCode Zen 은 요청당 과금됩니다. 자세한 내용은 OpenCode 대시보드를 확인하세요.
