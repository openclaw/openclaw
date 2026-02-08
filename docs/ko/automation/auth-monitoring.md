---
read_when:
    - 인증 만료 모니터링 또는 알림 설정
    - Claude Code / Codex OAuth 새로 고침 확인 자동화
summary: 모델 공급자의 OAuth 만료 모니터링
title: 인증 모니터링
x-i18n:
    generated_at: "2026-02-08T15:45:57Z"
    model: gtx
    provider: google-translate
    source_hash: eef179af9545ed7ab881f3ccbef998869437fb50cdb4088de8da7223b614fa2b
    source_path: automation/auth-monitoring.md
    workflow: 15
---

# 인증 모니터링

OpenClaw는 다음을 통해 OAuth 만료 상태를 노출합니다. `openclaw models status`. 그것을 사용하십시오
자동화 및 경고; 스크립트는 전화 작업 흐름을 위한 추가 옵션입니다.

## 선호: CLI 검사(이식 가능)

```bash
openclaw models status --check
```

종료 코드:

- `0`: 좋아요
- `1`: 자격 증명이 만료되었거나 누락되었습니다.
- `2`: 곧 만료됨(24시간 이내)

이는 cron/systemd에서 작동하며 추가 스크립트가 필요하지 않습니다.

## 선택적 스크립트(운영/전화 워크플로)

이들은 아래에 산다 `scripts/` 그리고는 **선택 과목**. 그들은 SSH 액세스를 가정합니다.
게이트웨이 호스트이며 systemd + Termux에 맞게 조정되었습니다.

- `scripts/claude-auth-status.sh` 지금은 `openclaw models status --json` 으로
  정보 소스(CLI를 사용할 수 없는 경우 직접 파일 읽기로 대체)
  그러니 계속 `openclaw` ~에 `PATH` 타이머용.
- `scripts/auth-monitor.sh`: cron/systemd 타이머 대상; 경고를 보냅니다(ntfy 또는 전화).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: 시스템화된 사용자 타이머.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw 인증 검사기(full/json/simple).
- `scripts/mobile-reauth.sh`: SSH를 통한 재인증 흐름 안내.
- `scripts/termux-quick-auth.sh`: 원탭 위젯 상태 + 인증 URL 열기.
- `scripts/termux-auth-widget.sh`: 전체 안내 위젯 흐름.
- `scripts/termux-sync-widget.sh`: Claude Code 자격 증명 → OpenClaw를 동기화합니다.

전화 자동화나 시스템 타이머가 필요하지 않다면 이 스크립트를 건너뛰세요.
