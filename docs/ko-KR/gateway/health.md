---
summary: "Health check steps for channel connectivity"
read_when:
  - Diagnosing WhatsApp channel health
title: "Health Checks"
x-i18n:
  source_hash: 74f242e98244c135e1322682ed6b67d70f3b404aca783b1bb5de96a27c2c1b01
---

# 상태 점검(CLI)

추측하지 않고 채널 연결을 확인하는 간단한 가이드입니다.

## 빠른 확인

- `openclaw status` — 로컬 요약: 게이트웨이 연결 가능성/모드, 업데이트 힌트, 연결된 채널 인증 기간, 세션 + 최근 활동.
- `openclaw status --all` — 전체 로컬 진단(읽기 전용, 색상, 디버깅을 위해 붙여넣기에 안전함).
- `openclaw status --deep` - 실행 중인 게이트웨이도 조사합니다(지원되는 경우 채널별 조사).
- `openclaw health --json` — 실행 중인 게이트웨이에 전체 상태 스냅샷을 요청합니다(WS 전용, 직접 Baileys 소켓 없음).
- 에이전트를 호출하지 않고도 상태 응답을 받으려면 WhatsApp/WebChat에서 독립 실행형 메시지로 `/status`를 보냅니다.
- 로그: `/tmp/openclaw/openclaw-*.log` 꼬리 및 `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`에 대한 필터.

## 심층 진단

- 디스크의 자격 증명: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime은 최신이어야 합니다).
- 세션 저장소: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (경로는 구성에서 재정의될 수 있습니다). 개수와 최근 수신자는 `status`를 통해 표시됩니다.
- 로그에 상태 코드 409~515 또는 `loggedOut`가 나타날 때 재연결 흐름: `openclaw channels logout && openclaw channels login --verbose`. (참고: QR 로그인 흐름은 페어링 후 상태 515에 대해 한 번 자동으로 다시 시작됩니다.)

## 뭔가 실패했을 때

- `logged out` 또는 상태 409~515 → `openclaw channels logout`와 `openclaw channels login`로 다시 연결합니다.
- 게이트웨이에 연결할 수 없음 → 시작: `openclaw gateway --port 18789` (포트가 사용 중인 경우 `--force` 사용)
- 인바운드 메시지 없음 → 연결된 전화가 온라인이고 발신자가 허용되는지 확인하세요(`channels.whatsapp.allowFrom`). 그룹 채팅의 경우 허용 목록 + 멘션 규칙이 일치하는지 확인하세요(`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## 전용 "건강" 명령

`openclaw health --json` 실행 중인 게이트웨이에 상태 스냅샷을 요청합니다(CLI에서 직접 채널 소켓 없음). 사용 가능한 경우 연결된 자격 증명/인증 기간, 채널별 프로브 요약, 세션 저장소 요약 및 프로브 기간을 보고합니다. 게이트웨이에 연결할 수 없거나 프로브가 실패하거나 시간 초과되면 0이 아닌 값으로 종료됩니다. 10초 기본값을 무시하려면 `--timeout <ms>`를 사용하세요.
