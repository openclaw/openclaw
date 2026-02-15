---
summary: "Use OpenCode Zen (curated models) with OpenClaw"
read_when:
  - You want OpenCode Zen for model access
  - You want a curated list of coding-friendly models
title: "OpenCode Zen"
x-i18n:
  source_hash: b3b5c640ac32f3177f6f4ffce766f3f57ff75c6ca918822c817d9a18f680be8f
---

# 오픈코드 젠

OpenCode Zen은 OpenCode 팀에서 코딩 에이전트를 위해 권장하는 **선별된 모델 목록**입니다.
API 키와 `opencode` 공급자를 사용하는 선택적 호스팅 모델 액세스 경로입니다.
Zen은 현재 베타 버전입니다.

## CLI 설정

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## 구성 스니펫

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 메모

- `OPENCODE_ZEN_API_KEY`도 지원됩니다.
- Zen에 로그인하여 청구 세부 정보를 추가하고 API 키를 복사합니다.
- 요청당 OpenCode Zen 청구서; 자세한 내용은 OpenCode 대시보드를 확인하세요.
