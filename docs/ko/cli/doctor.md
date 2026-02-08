---
read_when:
    - 연결/인증 문제가 있으며 안내에 따른 수정이 필요합니다.
    - 업데이트했고 상태 확인을 원합니다.
summary: '`openclaw doctor`에 대한 CLI 참조(상태 확인 + 안내식 수리)'
title: 의사
x-i18n:
    generated_at: "2026-02-08T15:49:00Z"
    model: gtx
    provider: google-translate
    source_hash: 92310aa3f3d111e91a74ce1150359d5d8a8d70a856666d9419e16c60d78209f2
    source_path: cli/doctor.md
    workflow: 15
---

# `openclaw doctor`

게이트웨이 및 채널에 대한 상태 확인 + 빠른 수정.

관련된:

- 문제 해결: [문제 해결](/gateway/troubleshooting)
- 보안 감사: [보안](/gateway/security)

## 예

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

참고:

- 대화형 프롬프트(예: 키체인/OAuth 수정)는 stdin이 TTY이고 `--non-interactive` ~이다 **~ 아니다** 세트. 헤드리스 실행(cron, Telegram, 터미널 없음)은 프롬프트를 건너뜁니다.
- `--fix` (별칭 `--repair`)에 백업을 씁니다. `~/.openclaw/openclaw.json.bak` 알 수 없는 구성 키를 삭제하고 각 제거 항목을 나열합니다.

## 맥OS: `launchctl` 환경 재정의

이전에 실행한 경우 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (또는 `...PASSWORD`), 해당 값은 구성 파일을 무시하고 지속적인 "승인되지 않은" 오류를 일으킬 수 있습니다.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
