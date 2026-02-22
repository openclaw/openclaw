---
summary: "페어링 개요: 다이렉트 메시지를 보낼 수 있는 사람과 게이트웨이 네트워크에 참가할 수 있는 노드를 승인"
read_when:
  - DM 접근 제어 설정
  - 새로운 iOS/Android 노드 페어링
  - OpenClaw 보안 자세 검토
title: "페어링"
---

# 페어링

"페어링"은 OpenClaw의 명시적인 **소유자 승인** 단계입니다. 두 곳에서 사용됩니다:

1. **DM 페어링** (봇과 대화할 수 있는 사람)
2. **노드 페어링** (게이트웨이 네트워크에 참가할 수 있는 장치/노드)

보안 컨텍스트: [보안](/ko-KR/gateway/security)

## 1) DM 페어링 (수신 채팅 접근)

채널이 DM 정책 `pairing`으로 설정되어 있을 때, 알 수 없는 발신자는 짧은 코드를 받고 그들의 메시지는 당신이 승인할 때까지 **처리되지 않습니다**.

기본 DM 정책은 여기에 문서화되어 있습니다: [보안](/ko-KR/gateway/security)

페어링 코드:

- 8자, 대문자, 모호한 문자가 없음 (`0O1I`).
- **1시간 후 만료됨**. 봇은 새로운 요청이 생성될 때만 페어링 메시지를 보냅니다 (발신자당 대략 한 시간에 한 번).
- 기본적으로 대기 중인 DM 페어링 요청은 **채널당 3개**로 제한되며, 하나가 만료되거나 승인될 때까지 추가 요청은 무시됩니다.

### 발신자 승인

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

지원되는 채널: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### 상태 저장 위치

`~/.openclaw/credentials/`에 저장됨:

- 대기 중인 요청: `<channel>-pairing.json`
- 승인된 허용 목록 저장소: `<channel>-allowFrom.json`

이것을 민감하게 처리하세요 (당신의 비서 접근을 제어합니다).

## 2) 노드 장치 페어링 (iOS/Android/macOS/헤드리스 노드)

노드는 **장치**로 `role: node`로 게이트웨이에 연결됩니다. 게이트웨이는 승인되어야 하는 장치 페어링 요청을 만듭니다.

### Telegram을 통한 페어링 (iOS를 위한 추천 방법)

`device-pair` 플러그인을 사용하면, Telegram에서 처음으로 장치 페어링을 완전히 수행할 수 있습니다:

1. Telegram에서 봇에게 메시지 보내기: `/pair`
2. 봇이 두 개의 메시지를 응답: 하나는 지침 메시지, 하나는 별도의 **설정 코드** 메시지 (Telegram에서 쉽게 복사/붙여넣기 가능).
3. 휴대폰에서, OpenClaw iOS 앱 → 설정 → 게이트웨이 열기.
4. 설정 코드를 붙여넣고 연결하기.
5. Telegram으로 돌아가서: `/pair approve`

설정 코드는 다음을 포함하는 base64로 인코딩된 JSON 페이로드입니다:

- `url`: 게이트웨이 WebSocket URL (`ws://...` 또는 `wss://...`)
- `token`: 단기 페어링 토큰

설정 코드를 유효할 동안 비밀번호처럼 취급하세요.

### 노드 장치 승인

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 노드 페어링 상태 저장

`~/.openclaw/devices/`에 저장됨:

- `pending.json` (단기; 대기 중인 요청은 만료됨)
- `paired.json` (페어링된 장치 + 토큰)

### 주의사항

- 이전 `node.pair.*` API (CLI: `openclaw nodes pending/approve`)는 별도의 게이트웨이 소유의 페어링 저장소입니다. WS 노드는 여전히 장치 페어링이 필요합니다.

## 관련 문서

- 보안 모델 + 프롬프트 인젝션: [보안](/ko-KR/gateway/security)
- 안전하게 업데이트 (doctor 실행): [업데이트](/ko-KR/install/updating)
- 채널 설정:
  - Telegram: [Telegram](/ko-KR/channels/telegram)
  - WhatsApp: [WhatsApp](/ko-KR/channels/whatsapp)
  - Signal: [Signal](/ko-KR/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/ko-KR/channels/bluebubbles)
  - iMessage (레거시): [iMessage](/ko-KR/channels/imessage)
  - Discord: [Discord](/ko-KR/channels/discord)
  - Slack: [Slack](/ko-KR/channels/slack)