---
summary: "채널 연결 상태 확인 단계"
read_when:
  - WhatsApp 채널 상태를 진단할 때
title: "상태 확인"
x-i18n:
  source_path: docs/gateway/health.md
---

# 상태 확인 (CLI)

추측 없이 채널 연결을 검증하는 간단한 가이드입니다.

## 빠른 확인

- `openclaw status` -- 로컬 요약: Gateway 접근성/모드, 업데이트 힌트, 연결된 채널 인증 기간, 세션 + 최근 활동.
- `openclaw status --all` -- 전체 로컬 진단 (읽기 전용, 컬러, 디버깅용 붙여넣기 안전).
- `openclaw status --deep` -- 실행 중인 Gateway도 프로브합니다 (지원되는 경우 채널별 프로브).
- `openclaw health --json` -- 실행 중인 Gateway에 전체 상태 스냅샷을 요청합니다 (WS 전용; 직접 Baileys 소켓 없음).
- WhatsApp/WebChat에서 독립 메시지로 `/status`를 보내면 에이전트를 호출하지 않고 상태 응답을 받을 수 있습니다.
- 로그: `/tmp/openclaw/openclaw-*.log`를 tail하고 `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`로 필터링합니다.

## 심층 진단

- 디스크의 자격 증명: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime이 최근이어야 합니다).
- 세션 저장소: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (설정에서 경로를 재정의할 수 있습니다). 카운트와 최근 수신자는 `status`를 통해 표시됩니다.
- 재연결 플로우: 상태 코드 409-515 또는 `loggedOut`가 로그에 나타나면 `openclaw channels logout && openclaw channels login --verbose`. (참고: QR 로그인 플로우는 페어링 후 상태 515에서 한 번 자동 재시작합니다.)

## 상태 모니터 설정

- `gateway.channelHealthCheckMinutes`: Gateway가 채널 상태를 확인하는 빈도. 기본값: `5`. `0`으로 설정하면 전역적으로 상태 모니터 재시작을 비활성화합니다.
- `gateway.channelStaleEventThresholdMinutes`: 연결된 채널이 상태 모니터가 정체로 판단하고 재시작하기 전까지 유휴 상태로 유지될 수 있는 시간. 기본값: `30`. `gateway.channelHealthCheckMinutes` 이상으로 유지하세요.
- `gateway.channelMaxRestartsPerHour`: 채널/계정별 상태 모니터 재시작의 1시간 롤링 상한. 기본값: `10`.
- `channels.<provider>.healthMonitor.enabled`: 전역 모니터링은 유지하면서 특정 채널의 상태 모니터 재시작을 비활성화합니다.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: 채널 수준 설정보다 우선하는 다중 계정 오버라이드.
- 이러한 채널별 오버라이드는 현재 노출하는 내장 채널 모니터에 적용됩니다: Discord, Google Chat, iMessage, Microsoft Teams, Signal, Slack, Telegram, WhatsApp.

## 실패 시 대처

- `logged out` 또는 상태 409-515 → `openclaw channels logout` 후 `openclaw channels login`으로 재연결.
- Gateway 접근 불가 → 시작: `openclaw gateway --port 18789` (포트가 사용 중이면 `--force` 사용).
- 인바운드 메시지 없음 → 연결된 폰이 온라인이고 발신자가 허용되었는지 확인 (`channels.whatsapp.allowFrom`); 그룹 채팅의 경우, 허용 목록 + 멘션 규칙이 일치하는지 확인 (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## 전용 "health" 명령

`openclaw health --json`은 실행 중인 Gateway에 상태 스냅샷을 요청합니다 (CLI에서 직접 채널 소켓 없음). 가능한 경우 연결된 자격 증명/인증 기간, 채널별 프로브 요약, 세션 저장소 요약, 프로브 소요 시간을 보고합니다. Gateway에 접근할 수 없거나 프로브가 실패/시간 초과되면 0이 아닌 값으로 종료됩니다. `--timeout <ms>`로 기본값 10초를 재정의할 수 있습니다.
