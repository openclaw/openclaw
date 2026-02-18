---
summary: "`openclaw doctor` CLI 참조 (상태 점검 + 가이드 수리)"
read_when:
  - 연결/인증 문제를 겪고 있고 가이드 수리를 원할 때
  - 업데이트하고 무결성 검사를 하고 싶을 때
title: "doctor"
---

# `openclaw doctor`

게이트웨이 및 채널에 대한 상태 점검 + 빠른 수정.

관련 항목:

- 문제 해결: [문제 해결](/gateway/troubleshooting)
- 보안 감사: [보안](/gateway/security)

## 예제

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

참고 사항:

- 대화형 프롬프트(예: 키체인/OAuth 수정)는 표준 입력이 TTY이고 `--non-interactive`가 설정되어 있지 않을 때만 실행됩니다. 헤드리스 실행(크론, Telegram, 터미널 없음)에서는 프롬프트가 건너뜁니다.
- `--fix` (또는 `--repair`의 별칭)는 `~/.openclaw/openclaw.json.bak`에 백업을 작성하고 알 수 없는 설정 키를 제거하며, 각 삭제 항목을 나열합니다.

## macOS: `launchctl` 환경 변수 오버라이드

이전에 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (또는 `...PASSWORD`)를 실행한 경우, 해당 값이 설정 파일을 오버라이드하여 지속적인 "인증되지 않음" 오류를 유발할 수 있습니다.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
