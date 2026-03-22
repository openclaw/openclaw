---
summary: "모델 프로바이더의 OAuth 만료 모니터링"
read_when:
  - 인증 만료 모니터링 또는 알림을 설정할 때
  - Claude Code / Codex OAuth 갱신 확인을 자동화할 때
title: "인증 모니터링"
x-i18n:
  source_path: docs/automation/auth-monitoring.md
---

# 인증 모니터링

OpenClaw 은 `openclaw models status`를 통해 OAuth 만료 상태를 노출합니다. 자동화 및 알림에 이를 사용하세요; 스크립트는 폰 워크플로를 위한 선택적 추가 기능입니다.

## 권장: CLI 확인 (이식 가능)

```bash
openclaw models status --check
```

종료 코드:

- `0`: 정상
- `1`: 만료되었거나 누락된 자격 증명
- `2`: 곧 만료 (24 시간 이내)

이는 cron/systemd 에서 작동하며 추가 스크립트가 필요하지 않습니다.

## 선택적 스크립트 (ops / 폰 워크플로)

이들은 `scripts/` 아래에 있으며 **선택사항**입니다. Gateway 호스트에 대한 SSH 접근을 가정하며 systemd + Termux 에 최적화되어 있습니다.

- `scripts/claude-auth-status.sh`는 이제 `openclaw models status --json`을 신뢰 소스로 사용합니다 (CLI 를 사용할 수 없는 경우 직접 파일 읽기로 폴백). 타이머를 위해 `openclaw`를 `PATH`에 유지하세요.
- `scripts/auth-monitor.sh`: cron/systemd 타이머 대상; 알림을 보냅니다 (ntfy 또는 폰).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd 사용자 타이머.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw 인증 확인기 (full/json/simple).
- `scripts/mobile-reauth.sh`: SSH 를 통한 가이드 재인증 흐름.
- `scripts/termux-quick-auth.sh`: 원탭 위젯 상태 + 인증 URL 열기.
- `scripts/termux-auth-widget.sh`: 전체 가이드 위젯 흐름.
- `scripts/termux-sync-widget.sh`: Claude Code 자격 증명을 OpenClaw 에 동기화.

폰 자동화나 systemd 타이머가 필요하지 않으면 이 스크립트를 건너뛰세요.
