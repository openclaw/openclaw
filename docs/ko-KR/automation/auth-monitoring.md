---
summary: "모델 제공자에 대한 OAuth 만료 모니터링"
read_when:
  - "Auth 만료 모니터링 또는 경고를 설정할 때"
  - "Claude Code / Codex OAuth 새로고침 검사를 자동화할 때"
title: "Auth 모니터링"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/automation/auth-monitoring.md
  workflow: 15
---

# Auth 모니터링

OpenClaw는 `openclaw models status`를 통해 OAuth 만료 상태를 표시합니다. 자동화 및 경고에 사용; 스크립트는 선택적 추가 사항입니다.

## 선호: CLI 확인 (휴대용)

```bash
openclaw models status --check
```

종료 코드:

- `0`: OK
- `1`: 만료되거나 누락된 자격증명
- `2`: 곧 만료 (24시간 이내)

이것은 cron/systemd에서 작동하며 추가 스크립트가 필요하지 않습니다.

## 선택적 스크립트 (ops / 휴대폰 워크플로우)

이것들은 `scripts/` 아래에 있으며 **선택적**입니다. Gateway 호스트에 대한 SSH 접근을 가정하고 systemd + Termux에 대해 조정됩니다.

- `scripts/claude-auth-status.sh`는 이제 `openclaw models status --json`을 진리의 소스로 사용합니다 (CLI를 사용할 수 없으면 직접 파일 읽기로 폴백),
  따라서 타이머에 대해 `openclaw`를 `PATH`에 유지합니다.
- `scripts/auth-monitor.sh`: cron/systemd 타이머 대상; 경고를 전송합니다 (ntfy 또는 휴대폰).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd 사용자 타이머.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw auth 체커 (전체/json/간단).
- `scripts/mobile-reauth.sh`: SSH를 통한 안내 재인증 흐름.
- `scripts/termux-quick-auth.sh`: 일회성 위젯 상태 + 오픈 auth URL.
- `scripts/termux-auth-widget.sh`: 전체 안내 위젯 흐름.
- `scripts/termux-sync-widget.sh`: Claude Code creds → OpenClaw 동기화.

휴대폰 자동화나 systemd 타이머가 필요하지 않으면 이 스크립트를 건너뜁니다.
