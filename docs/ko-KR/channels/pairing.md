---
summary: "페어링 개요: DM 권한이 있는 사람 승인 + 어느 노드가 조인할 수 있는지"
read_when:
  - DM 접근 제어 설정 중
  - 새 iOS/Android 노드 페어링 중
  - OpenClaw 보안 태세 검토 중
title: "페어링"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/pairing.md
  workflow: 15
---

# 페어링

"페어링"은 OpenClaw 의 명시적인 **소유자 승인** 단계입니다.
두 가지 장소에서 사용됩니다:

1. **DM 페어링** (봇과 대화할 수 있는 사람)
2. **노드 페어링** (gateway 네트워크에 조인할 수 있는 장치/노드)

보안 컨텍스트: [보안](/gateway/security)

## 1) DM 페어링 (인바운드 채팅 액세스)

채널이 DM 정책 `pairing` 으로 구성되면 알 수 없는 발신자는 짧은 코드를 받고 승인될 때까지 메시지가 **처리되지 않습니다**.

기본 DM 정책은 다음에 문서화되어 있습니다: [보안](/gateway/security)

페어링 코드:

- 8 자, 대문자, 모호한 문자 없음 (`0O1I`).
- **1 시간 후 만료**. 봇은 새 요청이 생성될 때만 페어링 메시지를 보냅니다 (대략 발신자당 시간당 한 번).
- 대기 중인 DM 페어링 요청은 기본적으로 **채널당 3 개** 로 제한됩니다. 추가 요청은 하나가 만료되거나 승인될 때까지 무시됩니다.

### 발신자 승인

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

지원되는 채널: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### 상태가 저장되는 곳

`~/.openclaw/credentials/` 에 저장됨:

- 대기 중인 요청: `<channel>-pairing.json`
- 승인된 허용 목록 저장소:
  - 기본 계정: `<channel>-allowFrom.json`
  - 기본이 아닌 계정: `<channel>-<accountId>-allowFrom.json`

계정 범위 지정 동작:

- 기본이 아닌 계정은 범위가 지정된 허용 목록 파일만 읽고 씁니다.
- 기본 계정은 채널 범위 범위 없는 허용 목록 파일을 사용합니다.

이들을 민감한 것으로 취급하세요 (어시스턴트에 대한 액세스를 게이트합니다).

## 2) 노드 장치 페어링 (iOS/Android/macOS/헤드리스 노드)

노드는 `role: node` 로 **장치로** Gateway 에 연결합니다. Gateway 는
승인해야 하는 장치 페어링 요청을 만듭니다.

### Telegram 을 통한 페어링 (iOS에 권장)

`device-pair` 플러그인을 사용하면 Telegram 에서 완전히 첫 번째 장치 페어링을 수행할 수 있습니다:

1. Telegram 에서 봇에 메시지: `/pair`
2. 봇이 두 개 메시지로 회신: 지시 메시지 및 별도의 **설정 코드** 메시지 (Telegram 에서 복사/붙여넣기하기 쉬움).
3. 휴대폰에서 OpenClaw iOS 앱을 열기 → 설정 → Gateway.
4. 설정 코드를 붙여넣고 연결합니다.
5. Telegram 으로 돌아가기: `/pair approve`

설정 코드는 다음을 포함하는 base64 인코딩된 JSON 페이로드입니다:

- `url`: Gateway WebSocket URL (`ws://...` 또는 `wss://...`)
- `token`: 수명이 짧은 페어링 토큰

유효한 동안 설정 코드를 암호처럼 취급하세요.

### 노드 장치 승인

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 노드 페어링 상태 저장소

`~/.openclaw/devices/` 에 저장됨:

- `pending.json` (수명이 짧음. 대기 중인 요청이 만료됨)
- `paired.json` (페어링된 장치 + 토큰)

### 참고사항

- 레거시 `node.pair.*` API (CLI: `openclaw nodes pending/approve`) 은
  별도의 gateway 소유 페어링 저장소입니다. WS 노드는 여전히 장치 페어링이 필요합니다.

## 관련 문서

- 보안 모델 + 프롬프트 주입: [보안](/gateway/security)
- 안전하게 업데이트 (doctor 실행): [업데이트](/install/updating)
- 채널 구성:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (레거시): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
