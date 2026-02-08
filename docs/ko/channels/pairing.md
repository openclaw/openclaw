---
summary: "페어링 개요: 누가 다이렉트 메시지를 보낼 수 있는지와 어떤 노드가 참여할 수 있는지 승인"
read_when:
  - 다이렉트 메시지 액세스 제어 설정
  - 새로운 iOS/Android 노드 페어링
  - OpenClaw 보안 태세 검토
title: "페어링"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:02Z
---

# 페어링

‘페어링’은 OpenClaw의 명시적인 **소유자 승인** 단계입니다.
다음 두 가지 경우에 사용됩니다:

1. **다이렉트 메시지 페어링** (봇과 대화할 수 있는 대상)
2. **노드 페어링** (Gateway(게이트웨이) 네트워크에 참여할 수 있는 디바이스/노드)

보안 맥락: [Security](/gateway/security)

## 1) 다이렉트 메시지 페어링 (인바운드 채팅 액세스)

채널이 DM 정책 `pairing`로 구성된 경우, 알 수 없는 발신자는 짧은 코드를 받으며 승인될 때까지 메시지가 **처리되지 않습니다**.

기본 DM 정책은 다음 문서에 설명되어 있습니다: [Security](/gateway/security)

페어링 코드:

- 8자, 대문자, 혼동될 수 있는 문자는 제외 (`0O1I`).
- **1시간 후 만료**됩니다. 봇은 새로운 요청이 생성될 때만 페어링 메시지를 전송합니다 (대략 발신자당 시간당 1회).
- 대기 중인 다이렉트 메시지 페어링 요청은 기본적으로 **채널당 3개**로 제한되며, 하나가 만료되거나 승인될 때까지 추가 요청은 무시됩니다.

### 발신자 승인

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

지원되는 채널: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### 상태 저장 위치

`~/.openclaw/credentials/` 아래에 저장됩니다:

- 대기 중 요청: `<channel>-pairing.json`
- 승인된 허용 목록 저장소: `<channel>-allowFrom.json`

이 항목들은 민감하게 취급하십시오 (어시스턴트에 대한 액세스를 제어합니다).

## 2) 노드 디바이스 페어링 (iOS/Android/macOS/헤드리스 노드)

노드는 `role: node`을(를) 사용하는 **디바이스**로서 Gateway(게이트웨이)에 연결됩니다. Gateway(게이트웨이)는 승인되어야 하는 디바이스 페어링 요청을 생성합니다.

### 노드 디바이스 승인

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 노드 페어링 상태 저장소

`~/.openclaw/devices/` 아래에 저장됩니다:

- `pending.json` (단기; 대기 중 요청은 만료됨)
- `paired.json` (페어링된 디바이스 + 토큰)

### 참고

- 레거시 `node.pair.*` API (CLI: `openclaw nodes pending/approve`)는
  Gateway(게이트웨이) 소유의 별도 페어링 저장소입니다. WS 노드는 여전히 디바이스 페어링이 필요합니다.

## 관련 문서

- 보안 모델 + 프롬프트 인젝션: [Security](/gateway/security)
- 안전한 업데이트 (doctor 실행): [Updating](/install/updating)
- 채널 구성:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (레거시): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
