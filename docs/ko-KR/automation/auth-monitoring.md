---
summary: "모델 제공자의 OAuth 만료 모니터링"
read_when:
  - 인증 만료 모니터링 또는 경고 설정 시
  - Claude Code / Codex OAuth 갱신 확인 자동화 시
title: "인증 모니터링"
---

# 인증 모니터링

OpenClaw는 `openclaw models status`를 통해 OAuth 만료 상태를 노출합니다. 이를 자동화 및 경고에 활용하십시오. 스크립트는 전화 워크플로우용 선택적 추가입니다.

## 권장: CLI 검사 (이식 가능)

```bash
openclaw models status --check
```

종료 코드:

- `0`: 정상
- `1`: 만료되었거나 누락된 자격 증명
- `2`: 곧 만료 (24시간 이내)

이것은 cron/systemd에서 작동하며 추가 스크립트가 필요하지 않습니다.

## 선택적 스크립트 (운영 / 전화 워크플로우)

이들은 `scripts/` 아래에 있으며 **선택적**입니다. 게이트웨이 호스트에 대한 SSH 접근을 가정하며 systemd + Termux에 맞게 조정되어 있습니다.

- `scripts/claude-auth-status.sh`는 이제 `openclaw models status --json`을 진실의 원천으로 사용하고 (CLI를 사용할 수 없는 경우 직접 파일 읽기로 대체), 타이머를 위해 `PATH`에 `openclaw`를 유지하십시오.
- `scripts/auth-monitor.sh`: cron/systemd 타이머 대상; 경고를 전송 (ntfy 또는 전화).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd 사용자 타이머.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw 인증 검사기 (전체/json/간단).
- `scripts/mobile-reauth.sh`: SSH를 통한 안내된 재인증 흐름.
- `scripts/termux-quick-auth.sh`: 원탭 위젯 상태 + 인증 URL 열기.
- `scripts/termux-auth-widget.sh`: 전체 안내된 위젯 흐름.
- `scripts/termux-sync-widget.sh`: Claude Code 자격 증명 동기화 → OpenClaw.

폰 자동화 또는 systemd 타이머가 필요하지 않은 경우 이러한 스크립트는 건너뛰십시오.
