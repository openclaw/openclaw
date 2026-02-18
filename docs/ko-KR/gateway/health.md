---
summary: "채널 연결 상태 확인 절차"
read_when:
  - WhatsApp 채널 상태를 진단할 때
title: "상태 확인"
---

# 상태 확인 (CLI)

추측 없이 채널 연결 상태를 검증하는 간단한 가이드입니다.

## 빠른 확인

- `openclaw status` — 로컬 요약: 게이트웨이 접근성/모드, 업데이트 힌트, 연결된 채널 인증 기간, 세션 + 최근 활동.
- `openclaw status --all` — 전체 로컬 진단 (읽기 전용, 색상 출력, 디버깅용 붙여넣기에 안전).
- `openclaw status --deep` — 실행 중인 게이트웨이도 프로브합니다 (지원되는 경우 채널별 프로브 포함).
- `openclaw health --json` — 실행 중인 게이트웨이에 전체 상태 스냅샷을 요청합니다 (WS 전용; Baileys 소켓 직접 연결 없음).
- WhatsApp/WebChat에서 `/status`를 독립 메시지로 전송하여 에이전트를 호출하지 않고 상태 응답을 받습니다.
- 로그: `/tmp/openclaw/openclaw-*.log`를 실시간으로 확인하고 `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`로 필터링합니다.

## 심층 진단

- 디스크의 자격 증명: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime이 최근이어야 합니다).
- 세션 저장소: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (경로는 설정에서 재정의 가능). `status`를 통해 개수와 최근 수신자가 표시됩니다.
- 재연결 흐름: 로그에서 상태 코드 409–515 또는 `loggedOut`이 나타나면 `openclaw channels logout && openclaw channels login --verbose`를 실행합니다. (참고: QR 로그인 흐름은 페어링 후 상태 515에 대해 한 번 자동 재시작됩니다.)

## 문제 발생 시

- `logged out` 또는 상태 코드 409–515 → `openclaw channels logout` 후 `openclaw channels login`으로 재연결합니다.
- 게이트웨이 접근 불가 → 시작합니다: `openclaw gateway --port 18789` (포트가 사용 중이면 `--force` 사용).
- 수신 메시지 없음 → 연결된 전화기가 온라인 상태이고 발신자가 허용되었는지 확인합니다 (`channels.whatsapp.allowFrom`). 그룹 채팅의 경우 허용 목록 + 멘션 규칙이 일치하는지 확인합니다 (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## 전용 "health" 명령

`openclaw health --json`은 실행 중인 게이트웨이에 상태 스냅샷을 요청합니다 (CLI에서 채널 소켓에 직접 연결하지 않습니다). 연결된 자격 증명/인증 기간(가능한 경우), 채널별 프로브 요약, 세션 저장소 요약, 프로브 소요 시간을 보고합니다. 게이트웨이에 접근할 수 없거나 프로브가 실패/타임아웃되면 0이 아닌 종료 코드로 종료됩니다. `--timeout <ms>`를 사용하여 기본값 10초를 재정의할 수 있습니다.
