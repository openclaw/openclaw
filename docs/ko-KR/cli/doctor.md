---
summary: "Gateway 및 채널에 대한 건강 검사 + 안내식 수정"
read_when:
  - 연결/인증 문제가 있고 안내식 수정을 원할 때
  - 업데이트했고 건전성 검사를 원할 때
title: "doctor"
---

# `openclaw doctor`

Gateway 및 채널에 대한 건강 검사 + 빠른 수정입니다.

관련 사항:

- 문제 해결: [Troubleshooting](/gateway/troubleshooting)
- 보안 감사: [Security](/gateway/security)

## 예시

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

참고:

- 대화형 프롬프트 (키체인/OAuth 수정 등) 는 stdin 이 TTY 이고 `--non-interactive` 가 **not** 설정된 경우에만 실행됩니다. 헤드리스 실행 (cron, Telegram, 터미널 없음) 은 프롬프트를 건너뜁니다.
- `--fix` (alias for `--repair`) 는 `~/.openclaw/openclaw.json.bak` 에 백업을 쓰고 알려지지 않은 구성 키를 삭제합니다 (각 제거 나열).
- 상태 무결성 검사는 이제 세션 디렉토리의 고아 트랜스크립트 파일을 감지하고 공간을 안전하게 회수하기 위해 `.deleted.<timestamp>` 로 아카이브할 수 있습니다.
- Doctor 는 메모리 검색 준비 검사를 포함하고 임베딩 자격 증명이 누락된 경우 `openclaw configure --section model` 을 권장할 수 있습니다.
- 샌드박스 모드가 활성화되었지만 Docker 를 사용할 수 없으면 doctor 는 개선 방안이 있는 높은 신호 경고를 보고합니다 (`Docker 설치` 또는 `openclaw config set agents.defaults.sandbox.mode off`).

## macOS: `launchctl` env 무시

이전에 `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (또는 `...PASSWORD`) 를 실행했다면, 해당 값은 구성 파일을 무시하고 지속적인 "unauthorized" 오류를 야기할 수 있습니다.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/doctor.md
workflow: 15
