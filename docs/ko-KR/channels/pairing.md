---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new iOS/Android node
  - Reviewing OpenClaw security posture
title: "Pairing"
x-i18n:
  source_hash: 60787f9e9cbd139175bf9790e63999c7d7e2ddcc790ed0689a6c9a89d9d56633
---

# 페어링

"페어링"은 OpenClaw의 명시적인 **소유자 승인** 단계입니다.
이는 두 가지 장소에서 사용됩니다:

1. **DM 페어링**(봇과 대화할 수 있는 사람)
2. **노드 페어링**(게이트웨이 네트워크에 연결할 수 있는 장치/노드)

보안 컨텍스트: [보안](/gateway/security)

## 1) DM 페어링(인바운드 채팅 접속)

채널이 DM 정책 `pairing`으로 구성된 경우 알 수 없는 발신자는 단축 코드를 받게 되며 해당 메시지는 귀하가 승인할 때까지 **처리되지 않습니다**.

기본 DM 정책은 [보안](/gateway/security)에 문서화되어 있습니다.

페어링 코드:

- 8자, 대문자, 모호한 문자 금지(`0O1I`).
- **1시간 후에 만료됩니다**. 봇은 새 요청이 생성될 때만 페어링 메시지를 보냅니다(발신자당 대략 시간당 한 번).
- 보류 중인 DM 페어링 요청은 기본적으로 **채널당 3**으로 제한됩니다. 추가 요청은 만료되거나 승인될 때까지 무시됩니다.

### 발신자 승인

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

지원되는 채널: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### 국가가 사는 곳

`~/.openclaw/credentials/`에 저장됨:

- 대기 중인 요청: `<channel>-pairing.json`
- 승인된 허용 목록 저장소: `<channel>-allowFrom.json`

이를 민감한 항목으로 취급하십시오(어시스턴트에 대한 액세스를 차단함).

## 2) 노드 장치 페어링(iOS/Android/macOS/헤드리스 노드)

노드는 `role: node`를 사용하여 **장치**로 게이트웨이에 연결됩니다. 게이트웨이
승인이 필요한 장치 페어링 요청을 생성합니다.

### 텔레그램을 통한 페어링(iOS 권장)

`device-pair` 플러그인을 사용하면 텔레그램에서 처음으로 장치 페어링을 완전히 수행할 수 있습니다.

1. 텔레그램에서 봇에게 메시지를 보내세요: `/pair`
2. 봇은 지침 메시지와 별도의 **설정 코드** 메시지(텔레그램에서 쉽게 복사/붙여넣기 가능)라는 두 가지 메시지로 응답합니다.
3. 휴대폰에서 OpenClaw iOS 앱 → 설정 → 게이트웨이를 엽니다.
4. 설정 코드를 붙여넣고 연결하세요.
5. 텔레그램으로 돌아가기: `/pair approve`

설정 코드는 다음을 포함하는 base64로 인코딩된 JSON 페이로드입니다.

- `url`: 게이트웨이 WebSocket URL (`ws://...` 또는 `wss://...`)
- `token`: 단기 페어링 토큰

설정 코드가 유효한 동안에는 비밀번호처럼 취급하십시오.

### 노드 장치 승인

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 노드 페어링 상태 저장

`~/.openclaw/devices/`에 저장됨:

- `pending.json` (단기, 보류 중인 요청 만료)
- `paired.json` (페어링된 장치 + 토큰)

### 메모

- 레거시 `node.pair.*` API(CLI: `openclaw nodes pending/approve`)는
  별도의 게이트웨이 소유 페어링 스토어. WS 노드에는 여전히 장치 페어링이 필요합니다.

## 관련 문서

- 보안 모델 + 프롬프트 주입: [보안](/gateway/security)
- 안전하게 업데이트 중(닥터 실행): [업데이트 중](/install/updating)
- 채널 구성:
  - 텔레그램 : [텔레그램](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - 신호 : [신호](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage(레거시): [iMessage](/channels/imessage)
  - 불일치: [불협화음](/channels/discord)
  - 슬랙: [슬랙](/channels/slack)
