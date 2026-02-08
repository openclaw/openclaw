---
read_when:
    - DM 접근 제어 설정
    - 새로운 iOS/Android 노드 페어링
    - OpenClaw 보안 상태 검토
summary: '페어링 개요: 나에게 DM을 보낼 수 있는 사람 + 참여할 수 있는 노드 승인'
title: 편성
x-i18n:
    generated_at: "2026-02-08T15:47:57Z"
    model: gtx
    provider: google-translate
    source_hash: cc6ce9c71db6d96db778d29501c5a9887f460c5a52511dd0e3925867da398d8f
    source_path: channels/pairing.md
    workflow: 15
---

# 편성

"페어링"은 OpenClaw의 명시적인 사항입니다. **소유자 승인** 단계.
이는 두 가지 장소에서 사용됩니다:

1. **DM 페어링** (봇과 대화할 수 있는 사람)
2. **노드 페어링** (게이트웨이 네트워크에 연결할 수 있는 장치/노드)

보안 컨텍스트: [보안](/gateway/security)

## 1) DM 페어링(인바운드 채팅 접속)

DM 정책으로 채널을 구성한 경우 `pairing`, 알 수 없는 발신자는 단축 코드를 받게 되며 해당 메시지는 다음과 같습니다. **처리되지 않음** 당신이 승인할 때까지.

기본 DM 정책은 다음 문서에 설명되어 있습니다. [보안](/gateway/security)

페어링 코드:

- 8자, 대문자, 모호한 문자 없음(`0O1I`).
- **1시간 후 만료**. 봇은 새 요청이 생성될 때만 페어링 메시지를 보냅니다(발신자당 대략 시간당 한 번).
- 보류 중인 DM 페어링 요청은 다음으로 제한됩니다. **채널당 3개** 기본적으로; 추가 요청은 만료되거나 승인될 때까지 무시됩니다.

### 발신자 승인

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

지원되는 채널: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### 국가가 사는 곳

다음 위치에 저장됨 `~/.openclaw/credentials/`:

- 대기 중인 요청: `<channel>-pairing.json`
- 승인된 허용 목록 저장소: `<channel>-allowFrom.json`

이를 민감한 항목으로 취급하십시오(어시스턴트에 대한 액세스를 차단함).

## 2) 노드 장치 페어링(iOS/Android/macOS/헤드리스 노드)

노드는 다음과 같이 게이트웨이에 연결됩니다. **장치** ~와 함께 `role: node`. 게이트웨이
승인이 필요한 장치 페어링 요청을 생성합니다.

### 노드 장치 승인

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 노드 페어링 상태 저장

다음 위치에 저장됨 `~/.openclaw/devices/`:

- `pending.json` (단기적, 보류 중인 요청이 만료됨)
- `paired.json` (페어링된 장치 + 토큰)

### 메모

- 유산 `node.pair.*` API(CLI: `openclaw nodes pending/approve`)는
  별도의 게이트웨이 소유 페어링 스토어. WS 노드에는 여전히 장치 페어링이 필요합니다.

## 관련 문서

- 보안 모델 + 프롬프트 주입: [보안](/gateway/security)
- 안전하게 업데이트하는 중(닥터 실행): [업데이트 중](/install/updating)
- 채널 구성:
  - 전보: [전보](/channels/telegram)
  - 왓츠앱: [왓츠앱](/channels/whatsapp)
  - 신호: [신호](/channels/signal)
  - BlueBubbles(iMessage): [블루버블스](/channels/bluebubbles)
  - iMessage(기존): [아이메시지](/channels/imessage)
  - 불화: [불화](/channels/discord)
  - 느슨하게: [느슨하게](/channels/slack)
