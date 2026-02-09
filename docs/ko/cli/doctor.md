---
summary: "`openclaw doctor`에 대한 CLI 참조 (상태 확인 + 안내식 복구)"
read_when:
  - 연결/인증 문제가 있으며 안내식 해결을 원할 때
  - 업데이트를 완료했고 정상 여부를 확인하고 싶음
title: "doctor"
---

# `openclaw doctor`

게이트웨이와 채널을 위한 상태 점검 + 빠른 수정 기능입니다.

관련 문서:

- 문제 해결: [Troubleshooting](/gateway/troubleshooting)
- 보안 감사: [Security](/gateway/security)

## Examples

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notes:

- 대화형 프롬프트(예: 키체인/OAuth 수정)는 stdin 이 TTY 이고 `--non-interactive` 가 설정되지 않은 경우에만 실행됩니다. 헤드리스 실행(cron, Telegram, 터미널 없음)에서는 프롬프트가 건너뜁니다.
- `--fix`(`--repair` 의 별칭)는 `~/.openclaw/openclaw.json.bak` 에 백업을 기록하고, 알 수 없는 설정 키를 제거하며 각 제거 항목을 나열합니다.

## macOS: `launchctl` 환경 변수 재정의

이전에 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`(또는 `...PASSWORD`)를 실행했다면, 해당 값이 설정 파일을 재정의하여 지속적인 'unauthorized' 오류를 유발할 수 있습니다.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
