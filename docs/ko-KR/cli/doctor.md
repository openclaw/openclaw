---
summary: "CLI reference for `openclaw doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "doctor"
x-i18n:
  source_hash: 92310aa3f3d111e91a74ce1150359d5d8a8d70a856666d9419e16c60d78209f2
---

# `openclaw doctor`

게이트웨이 및 채널에 대한 상태 확인 + 빠른 수정.

관련 항목:

- 문제 해결: [문제 해결](/gateway/troubleshooting)
- 보안 감사: [보안](/gateway/security)

## 예

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

참고:

- 대화형 프롬프트(예: 키체인/OAuth 수정)는 stdin이 TTY이고 `--non-interactive`가 설정되지 않은 **경우에만** 실행됩니다. 헤드리스 실행(cron, Telegram, 터미널 없음)은 프롬프트를 건너뜁니다.
- `--fix`(`--repair`의 별칭)는 `~/.openclaw/openclaw.json.bak`에 백업을 쓰고 알 수 없는 구성 키를 삭제하여 각 제거 목록을 나열합니다.

## macOS: `launchctl` env 재정의

이전에 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...`(또는 `...PASSWORD`)를 실행한 경우 해당 값이 구성 파일을 재정의하고 지속적인 "무단" 오류가 발생할 수 있습니다.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
