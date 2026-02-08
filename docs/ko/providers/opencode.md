---
read_when:
    - 모델 액세스를 위해 OpenCode Zen을 원합니다
    - 코딩 친화적인 모델의 선별된 목록을 원합니다.
summary: OpenClaw와 함께 OpenCode Zen(선별된 모델) 사용
title: 오픈코드 젠
x-i18n:
    generated_at: "2026-02-08T16:09:24Z"
    model: gtx
    provider: google-translate
    source_hash: b3b5c640ac32f3177f6f4ffce766f3f57ff75c6ca918822c817d9a18f680be8f
    source_path: providers/opencode.md
    workflow: 15
---

# 오픈코드 젠

오픈코드 Zen은 **엄선된 모델 목록** 코딩 에이전트를 위해 OpenCode 팀에서 권장합니다.
이는 API 키와 `opencode` 공급자.
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

- `OPENCODE_ZEN_API_KEY` 도 지원됩니다.
- Zen에 로그인하여 청구 세부 정보를 추가하고 API 키를 복사합니다.
- 요청당 OpenCode Zen 청구서; 자세한 내용은 OpenCode 대시보드를 확인하세요.
