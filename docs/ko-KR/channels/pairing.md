---
summary: "페어링 개요: DM 을 보낼 수 있는 사람 승인 + 가입할 수 있는 노드 승인"
read_when:
  - DM 접근 제어를 설정하는 경우
  - 새 iOS/Android 노드를 페어링하는 경우
  - OpenClaw 보안 상태를 검토하는 경우
title: "페어링"
x-i18n:
  source_path: docs/channels/pairing.md
---

# 페어링

"페어링"은 OpenClaw 의 명시적 **소유자 승인** 단계입니다.
두 곳에서 사용됩니다:

1. **DM 페어링** (봇과 대화할 수 있는 사람)
2. **노드 페어링** (Gateway 네트워크에 가입할 수 있는 장치/노드)

보안 컨텍스트: [Security](/gateway/security)

## 1) DM 페어링 (인바운드 채팅 접근)

채널이 DM 정책 `pairing` 으로 구성된 경우, 알 수 없는 발신자는 짧은 코드를 받으며 승인할 때까지 메시지가 **처리되지 않습니다**.

기본 DM 정책은 다음에 문서화되어 있습니다: [Security](/gateway/security)

페어링 코드:

- 8 자, 대문자, 모호한 문자 없음 (`0O1I`).
- **1 시간 후 만료**. 봇은 새 요청이 생성될 때만 페어링 메시지를 보냅니다 (발신자당 대략 시간당 한 번).
- 채널당 대기 중인 DM 페어링 요청은 기본적으로 **3 개**로 제한됩니다. 추가 요청은 하나가 만료되거나 승인될 때까지 무시됩니다.

### 발신자 승인

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

지원 채널: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### 상태 저장 위치

`~/.openclaw/credentials/` 하위에 저장됩니다:

- 대기 중인 요청: `<channel>-pairing.json`
- 승인된 허용 목록 저장소:
  - 기본 계정: `<channel>-allowFrom.json`
  - 기본이 아닌 계정: `<channel>-<accountId>-allowFrom.json`

계정 범위 지정 동작:

- 기본이 아닌 계정은 범위가 지정된 허용 목록 파일만 읽고 씁니다.
- 기본 계정은 채널 범위의 허용 목록 파일을 사용합니다.

이것들은 민감한 정보로 취급하세요 (어시스턴트 접근을 제어합니다).

## 2) 노드 장치 페어링 (iOS/Android/macOS/헤드리스 노드)

노드는 `role: node` 로 **장치**로서 Gateway 에 연결합니다. Gateway 는 승인이 필요한 장치 페어링 요청을 생성합니다.

### Telegram 을 통한 페어링 (iOS 에 권장)

`device-pair` 플러그인을 사용하면 Telegram 에서 완전히 최초 장치 페어링을 수행할 수 있습니다:

1. Telegram 에서 봇에게 메시지 보내기: `/pair`
2. 봇이 두 개의 메시지로 응답합니다: 안내 메시지와 별도의 **설정 코드** 메시지 (Telegram 에서 복사/붙여넣기가 쉬움).
3. 휴대폰에서 OpenClaw iOS 앱 열기 → Settings → Gateway.
4. 설정 코드를 붙여넣고 연결합니다.
5. Telegram 으로 돌아가기: `/pair pending` (요청 ID, 역할, 범위 확인), 그런 다음 승인합니다.

설정 코드는 다음을 포함하는 base64 인코딩된 JSON 페이로드입니다:

- `url`: Gateway WebSocket URL (`ws://...` 또는 `wss://...`)
- `bootstrapToken`: 초기 페어링 핸드셰이크에 사용되는 단기 단일 장치 부트스트랩 토큰

설정 코드가 유효한 동안 비밀번호처럼 취급하세요.

### 노드 장치 승인

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

동일한 장치가 다른 인증 세부 정보 (예: 다른 역할/범위/공개 키) 로 재시도하면 이전 대기 요청이 대체되고 새 `requestId` 가 생성됩니다.

### 노드 페어링 상태 저장

`~/.openclaw/devices/` 하위에 저장됩니다:

- `pending.json` (단기; 대기 요청 만료)
- `paired.json` (페어링된 장치 + 토큰)

### 참고 사항

- 레거시 `node.pair.*` API (CLI: `openclaw nodes pending/approve`) 는 별도의 Gateway 소유 페어링 저장소입니다. WS 노드는 여전히 장치 페어링이 필요합니다.

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
