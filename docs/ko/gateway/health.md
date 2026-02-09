---
summary: "채널 연결성에 대한 상태 확인 단계"
read_when:
  - WhatsApp 채널 상태를 진단할 때
title: "Health Checks"
---

# 상태 확인 (CLI)

추측 없이 채널 연결성을 검증하기 위한 간단한 가이드입니다.

## 빠른 확인

- `openclaw status` — 로컬 요약: Gateway(게이트웨이) 도달 가능성/모드, 업데이트 힌트, 연결된 채널 인증 경과 시간, 세션 + 최근 활동.
- `openclaw status --all` — 전체 로컬 진단 (읽기 전용, 컬러 출력, 디버깅을 위해 그대로 붙여넣어도 안전).
- `openclaw status --deep` — 실행 중인 Gateway(게이트웨이)도 함께 프로브합니다 (지원되는 경우 채널별 프로브).
- `openclaw health --json` — 실행 중인 Gateway(게이트웨이)에 전체 상태 스냅샷을 요청합니다 (WS 전용; 직접적인 Baileys 소켓 없음).
- WhatsApp/WebChat 에서 에이전트를 호출하지 않고 상태 응답을 받으려면 `/status` 를 단독 메시지로 전송합니다.
- 로그: `/tmp/openclaw/openclaw-*.log` 를 tail 하고 `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound` 로 필터링합니다.

## 심층 진단

- 디스크의 자격 증명: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime 은 최근이어야 합니다).
- 세션 저장소: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (경로는 설정에서 재정의할 수 있습니다). 개수와 최근 수신자는 `status` 를 통해 표시됩니다.
- 재연결 흐름: 로그에 상태 코드 409–515 또는 `loggedOut` 가 나타날 때 `openclaw channels logout && openclaw channels login --verbose` 를 실행합니다. (참고: QR 로그인 흐름은 페어링 이후 상태 515 에 대해 한 번 자동으로 재시작됩니다.)

## 문제가 발생했을 때

- `logged out` 또는 상태 409–515 → `openclaw channels logout` 로 재연결한 다음 `openclaw channels login` 을 실행합니다.
- Gateway(게이트웨이)에 도달할 수 없음 → 시작합니다: `openclaw gateway --port 18789` (포트가 사용 중이면 `--force` 사용).
- 인바운드 메시지가 없음 → 연결된 휴대폰이 온라인인지와 발신자가 허용되어 있는지 확인합니다 (`channels.whatsapp.allowFrom`); 그룹 채팅의 경우 허용 목록 + 멘션 규칙이 일치하는지 확인합니다 (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## 전용 'health' 명령

`openclaw health --json` 는 실행 중인 Gateway(게이트웨이)에 상태 스냅샷을 요청합니다 (CLI 에서 직접적인 채널 소켓은 사용하지 않음). 사용 가능한 경우 연결된 자격 증명/인증 경과 시간, 채널별 프로브 요약, 세션 저장소 요약, 그리고 프로브 소요 시간을 보고합니다. Gateway(게이트웨이)에 도달할 수 없거나 프로브가 실패/타임아웃되면 비영(非零) 코드로 종료됩니다. 기본값 10초를 재정의하려면 `--timeout <ms>` 를 사용하십시오.
