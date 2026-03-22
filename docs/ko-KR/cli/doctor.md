---
summary: "`openclaw doctor` CLI 레퍼런스 (상태 점검 + 안내형 복구)"
read_when:
  - 연결/인증 문제가 있어 안내형 수정이 필요할 때
  - 업데이트 후 정상 동작을 확인하고 싶을 때
title: "doctor"
x-i18n:
  source_path: "docs/cli/doctor.md"
---

# `openclaw doctor`

Gateway와 채널을 위한 상태 점검 + 빠른 수정입니다.

관련 문서:

- 문제 해결: [Troubleshooting](/gateway/troubleshooting)
- 보안 감사: [Security](/gateway/security)

## 예시

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

참고:

- 대화형 프롬프트 (키체인/OAuth 수정 등)는 stdin이 TTY이고 `--non-interactive`가 설정되지 **않은** 경우에만 실행됩니다. 헤드리스 실행 (cron, Telegram, 터미널 없음)에서는 프롬프트를 건너뜁니다.
- `--fix` (`--repair`의 별칭)는 `~/.openclaw/openclaw.json.bak`에 백업을 작성하고 알 수 없는 설정 키를 제거하며 각 제거 항목을 나열합니다.
- 상태 무결성 검사가 이제 세션 디렉터리의 고아 트랜스크립트 파일을 감지하고, 안전하게 공간을 확보하기 위해 `.deleted.<timestamp>`로 아카이브할 수 있습니다.
- Doctor는 또한 `~/.openclaw/cron/jobs.json` (또는 `cron.store`)에서 레거시 크론 작업 형태를 스캔하고, 스케줄러가 런타임에 자동 정규화하기 전에 현장에서 다시 작성할 수 있습니다.
- Doctor에는 메모리 검색 준비 상태 확인이 포함되어 있으며, 임베딩 자격 증명이 누락된 경우 `openclaw configure --section model`을 권장할 수 있습니다.
- 샌드박스 모드가 활성화되었지만 Docker를 사용할 수 없는 경우, doctor는 해결 방법과 함께 높은 신호 경고를 보고합니다 (`install Docker` 또는 `openclaw config set agents.defaults.sandbox.mode off`).
- `gateway.auth.token`/`gateway.auth.password`가 SecretRef로 관리되고 현재 명령 경로에서 사용할 수 없는 경우, doctor는 읽기 전용 경고를 보고하며 평문 폴백 자격 증명을 쓰지 않습니다.
- 수정 경로에서 채널 SecretRef 검사가 실패하면, doctor는 조기 종료 대신 경고를 보고하고 계속합니다.
- Telegram `allowFrom` 사용자명 자동 해석 (`doctor --fix`)은 현재 명령 경로에서 해석 가능한 Telegram 토큰이 필요합니다. 토큰 검사를 사용할 수 없는 경우, doctor는 경고를 보고하고 해당 패스의 자동 해석을 건너뜁니다.

## macOS: `launchctl` 환경 오버라이드

이전에 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (또는 `...PASSWORD`)을 실행한 경우, 해당 값이 설정 파일을 재정의하여 지속적인 "unauthorized" 오류를 유발할 수 있습니다.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
