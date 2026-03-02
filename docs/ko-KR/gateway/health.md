---
summary: "채널 연결성에 대한 건강 확인 단계"
read_when:
  - WhatsApp 채널 건강을 진단할 때
title: "건강 확인 (CLI)"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/health.md
  workflow: 15
---

# 건강 확인 (CLI)

추측 없이 채널 연결성을 확인하기 위한 짧은 가이드.

## 빠른 확인

- `openclaw status` — 로컬 요약: Gateway 도달 가능성/모드, 업데이트 힌트, 링크된 채널 인증 나이, 세션 + 최근 활동.
- `openclaw status --all` — 전체 로컬 진단 (읽기 전용, 색상, 디버깅용 붙여넣기 안전).
- `openclaw status --deep` — 또한 실행 중인 Gateway 를 탐색합니다 (지원될 때 채널별 탐색).
- `openclaw health --json` — 실행 중인 Gateway 에서 전체 건강 스냅샷을 요청합니다 (WS 전용; 직접 Baileys 소켓 없음).
- WhatsApp/WebChat 에서 `/status` 를 독립 실행형 메시지로 보냅니다. 에이전트를 호출하지 않고 상태 응답을 받습니다.
- 로그: `/tmp/openclaw/openclaw-*.log` 를 추적하고 `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound` 를 필터링합니다.

## 깊은 진단

- 디스크의 자격 증명: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime 는 최근이어야 함).
- 세션 저장소: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (경로는 구성에서 오버라이드할 수 있음). 개수 및 최근 수신자는 `status` 를 통해 표시됩니다.
- 재링크 흐름: 상태 코드 409 - 515 또는 `loggedOut` 로그가 나타나면 `openclaw channels logout` 그리고 `openclaw channels login --verbose` 로 재링크합니다. (참고: QR 로그인 흐름은 페어링 후 상태 515 후 자동으로 재시작됩니다.)

## 뭔가 실패할 때

- `logged out` 또는 상태 409 - 515 → `openclaw channels logout` 을 사용하여 재링크한 후 `openclaw channels login` 합니다.
- Gateway 도달 불가능 → 시작: `openclaw gateway --port 18789` (포트가 바쁘면 `--force` 사용).
- 인바운드 메시지 없음 → 링크된 휴대폰이 온라인인지 확인하고 발신자가 허용됨 (`channels.whatsapp.allowFrom`); 그룹 채팅의 경우 허용 목록 + 언급 규칙 일치 확인 (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## 전용 "건강" 명령

`openclaw health --json` 는 실행 중인 Gateway 에서 건강 스냅샷을 요청합니다 (CLI 에서 직접 채널 소켓 없음). 사용 가능할 때 링크된 자격 증명/인증 나이, 채널별 탐색 요약, 세션 저장소 요약 및 탐색 기간을 보고합니다. Gateway 도달 불가능하거나 탐색 실패/시간 초과 시 0 이 아닌 상태로 종료합니다. `--timeout <ms>` 로 10 초 기본값을 오버라이드합니다.
