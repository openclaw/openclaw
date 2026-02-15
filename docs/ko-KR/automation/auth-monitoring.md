---
summary: "Monitor OAuth expiry for model providers"
read_when:
  - Setting up auth expiry monitoring or alerts
  - Automating Claude Code / Codex OAuth refresh checks
title: "Auth Monitoring"
x-i18n:
  source_hash: eef179af9545ed7ab881f3ccbef998869437fb50cdb4088de8da7223b614fa2b
---

# 인증 모니터링

OpenClaw는 `openclaw models status`를 통해 OAuth 만료 상태를 노출합니다. 그것을 사용하십시오
자동화 및 경고; 스크립트는 전화 작업 흐름을 위한 추가 옵션입니다.

## 선호: CLI 확인(이식 가능)

```bash
openclaw models status --check
```

종료 코드:

- `0`: OK
- `1`: 자격 증명이 만료되었거나 누락되었습니다.
- `2`: 곧 만료됨(24시간 이내)

이는 cron/systemd에서 작동하며 추가 스크립트가 필요하지 않습니다.

## 선택적 스크립트(운영/전화 워크플로)

이는 `scripts/` 아래에 있으며 **선택 사항**입니다. 그들은 SSH 액세스를 가정합니다.
게이트웨이 호스트이며 systemd + Termux에 맞게 조정되었습니다.

- `scripts/claude-auth-status.sh`는 이제 `openclaw models status --json`를 사용합니다.
  정보 소스(CLI를 사용할 수 없는 경우 직접 파일 읽기로 대체)
  타이머를 위해 `openclaw`를 `PATH`로 유지하세요.
- `scripts/auth-monitor.sh`: cron/systemd 타이머 대상; 경고를 보냅니다(ntfy 또는 전화).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: 시스템 사용자 타이머.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw 인증 검사기(full/json/simple).
- `scripts/mobile-reauth.sh`: SSH를 통한 재인증 흐름 안내.
- `scripts/termux-quick-auth.sh`: 원탭 위젯 상태 + 인증 URL 열기.
- `scripts/termux-auth-widget.sh`: 전체 안내 위젯 흐름.
- `scripts/termux-sync-widget.sh`: Claude Code 자격 증명 → OpenClaw를 동기화합니다.

전화 자동화나 시스템 타이머가 필요하지 않다면 이 스크립트를 건너뛰세요.
