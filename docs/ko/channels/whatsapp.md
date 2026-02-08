---
summary: "WhatsApp (웹 채널) 통합: 로그인, 인박스, 답장, 미디어, 운영"
read_when:
  - WhatsApp/웹 채널 동작 또는 인박스 라우팅 작업 시
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:48Z
---

# WhatsApp (웹 채널)

상태: Baileys를 통한 WhatsApp Web만 지원합니다. Gateway(게이트웨이)가 세션을 소유합니다.

## 빠른 설정 (초보자)

1. 가능하다면 **별도의 전화번호**를 사용하십시오 (권장).
2. `~/.openclaw/openclaw.json`에서 WhatsApp을 구성하십시오.
3. `openclaw channels login`을 실행하여 QR 코드(연결된 기기)를 스캔하십시오.
4. Gateway를 시작하십시오.

최소 구성:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## 목표

- 하나의 Gateway 프로세스에서 여러 WhatsApp 계정(멀티 계정) 지원.
- 결정적 라우팅: 답장은 WhatsApp으로 되돌아가며 모델 라우팅을 사용하지 않습니다.
- 모델이 인용된 답장을 이해할 수 있도록 충분한 컨텍스트 제공.

## 구성 쓰기

기본적으로 WhatsApp은 `/config set|unset`에 의해 트리거되는 구성 업데이트를 작성할 수 있습니다(`commands.config: true` 필요).

비활성화하려면:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## 아키텍처 (소유 주체)

- **Gateway**가 Baileys 소켓과 인박스 루프를 소유합니다.
- **CLI / macOS 앱**은 Gateway와 통신하며 Baileys를 직접 사용하지 않습니다.
- **활성 리스너**가 아웃바운드 전송에 필요하며, 없으면 전송이 즉시 실패합니다.

## 전화번호 확보 (두 가지 모드)

WhatsApp은 인증을 위해 실제 모바일 번호가 필요합니다. VoIP 및 가상 번호는 일반적으로 차단됩니다. OpenClaw를 WhatsApp에서 실행하는 두 가지 지원 방식이 있습니다.

### 전용 번호 (권장)

OpenClaw 전용으로 **별도의 전화번호**를 사용하십시오. 최상의 UX, 깔끔한 라우팅, 자기 자신 채팅의 특이점이 없습니다. 이상적인 구성은 **여분/구형 Android 휴대폰 + eSIM**입니다. Wi‑Fi와 전원을 유지한 상태로 QR로 연결하십시오.

**WhatsApp Business:** 동일한 기기에서 다른 번호로 WhatsApp Business를 사용할 수 있습니다. 개인 WhatsApp을 분리하는 데 매우 유용합니다. WhatsApp Business를 설치하고 OpenClaw 번호를 그곳에 등록하십시오.

**샘플 구성 (전용 번호, 단일 사용자 허용 목록):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**페어링 모드 (선택 사항):**  
허용 목록 대신 페어링을 원하면 `channels.whatsapp.dmPolicy`을 `pairing`로 설정하십시오. 알 수 없는 발신자는 페어링 코드를 받으며, 다음으로 승인합니다:
`openclaw pairing approve whatsapp <code>`

### 개인 번호 (대안)

빠른 대안: **본인 번호**로 OpenClaw를 실행합니다. 테스트 시 연락처를 스팸하지 않도록 자신에게 메시지(WhatsApp 'Message yourself')를 보내십시오. 설정 및 실험 중에는 기본 휴대폰에서 인증 코드를 확인해야 합니다. **자기 자신 채팅 모드를 반드시 활성화해야 합니다.**  
마법사가 개인 WhatsApp 번호를 요청하면, 어시스턴트 번호가 아니라 메시지를 보낼 번호(소유자/발신자)를 입력하십시오.

**샘플 구성 (개인 번호, 자기 자신 채팅):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

자기 자신 채팅 답장은 설정 시 기본적으로 `[{identity.name}]`를 사용합니다(그렇지 않으면 `[openclaw]`).  
`messages.responsePrefix`이 설정되지 않은 경우에 해당합니다. 접두어를 사용자 지정하거나 비활성화하려면 명시적으로 설정하십시오(제거하려면 `""` 사용).

### 번호 소싱 팁

- **현지 eSIM** (가장 신뢰성 높음)
  - 오스트리아: [hot.at](https://www.hot.at)
  - 영국: [giffgaff](https://www.giffgaff.com) — 무료 SIM, 무약정
- **선불 SIM** — 저렴하며 인증용 SMS 1건만 수신하면 됩니다.

**피하십시오:** TextNow, Google Voice, 대부분의 '무료 SMS' 서비스 — WhatsApp이 적극적으로 차단합니다.

**팁:** 번호는 인증용 SMS 1건만 수신하면 됩니다. 이후 WhatsApp Web 세션은 `creds.json`을 통해 유지됩니다.

## 왜 Twilio가 아닌가?

- 초기 OpenClaw 빌드는 Twilio의 WhatsApp Business 통합을 지원했습니다.
- WhatsApp Business 번호는 개인 비서 용도에 적합하지 않습니다.
- Meta는 24시간 응답 창을 강제합니다. 최근 24시간 내 응답이 없으면 비즈니스 번호는 새 메시지를 시작할 수 없습니다.
- 대량 또는 '수다스러운' 사용은 공격적인 차단을 유발합니다. 비즈니스 계정은 개인 비서 메시지를 수십 개 보내도록 설계되지 않았습니다.
- 결과적으로 전달 신뢰성이 낮고 차단이 잦아 지원이 제거되었습니다.

## 로그인 + 자격 증명

- 로그인 명령: `openclaw channels login` (연결된 기기를 통한 QR).
- 멀티 계정 로그인: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- 기본 계정(`--account` 생략 시): `default`이 있으면 해당 값, 아니면 구성된 첫 번째 계정 id(정렬 기준).
- 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`에 저장됩니다.
- 백업 사본은 `creds.json.bak`에 있습니다(손상 시 복원).
- 레거시 호환성: 이전 설치에서는 Baileys 파일을 `~/.openclaw/credentials/`에 직접 저장했습니다.
- 로그아웃: `openclaw channels logout` (또는 `--account <id>`)는 WhatsApp 인증 상태를 삭제합니다(공유 `oauth.json`는 유지).
- 로그아웃된 소켓 ⇒ 재연결을 지시하는 오류가 발생합니다.

## 인바운드 흐름 (다이렉트 메시지 + 그룹)

- WhatsApp 이벤트는 `messages.upsert` (Baileys)에서 옵니다.
- 테스트/재시작 시 이벤트 핸들러 누적을 방지하기 위해 종료 시 인박스 리스너를 분리합니다.
- 상태/브로드캐스트 채팅은 무시됩니다.
- 다이렉트 채팅은 E.164를 사용하며, 그룹은 그룹 JID를 사용합니다.
- **다이렉트 메시지 정책**: `channels.whatsapp.dmPolicy`가 다이렉트 채팅 접근을 제어합니다(기본값: `pairing`).
  - 페어링: 알 수 없는 발신자는 페어링 코드를 받습니다(`openclaw pairing approve whatsapp <code>`으로 승인; 코드는 1시간 후 만료).
  - 오픈: `channels.whatsapp.allowFrom`에 `"*"`가 포함되어야 합니다.
  - 연결된 본인 WhatsApp 번호는 암묵적으로 신뢰되므로, 자기 자신 메시지는 `channels.whatsapp.dmPolicy` 및 `channels.whatsapp.allowFrom` 검사를 건너뜁니다.

### 개인 번호 모드 (대안)

**개인 WhatsApp 번호**로 OpenClaw를 실행하는 경우 `channels.whatsapp.selfChatMode`을 활성화하십시오(위 샘플 참조).

동작:

- 아웃바운드 다이렉트 메시지는 페어링 답장을 트리거하지 않습니다(연락처 스팸 방지).
- 인바운드 알 수 없는 발신자는 여전히 `channels.whatsapp.dmPolicy`를 따릅니다.
- 자기 자신 채팅 모드(allowFrom에 본인 번호 포함)는 자동 읽음 영수증을 피하고 멘션 JID를 무시합니다.
- 자기 자신 채팅이 아닌 다이렉트 메시지에는 읽음 영수증이 전송됩니다.

## 읽음 영수증

기본적으로 Gateway는 수신된 WhatsApp 메시지를 수락하면 읽음(파란 체크)으로 표시합니다.

전역 비활성화:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

계정별 비활성화:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

참고:

- 자기 자신 채팅 모드는 항상 읽음 영수증을 건너뜁니다.

## WhatsApp FAQ: 메시지 전송 + 페어링

**WhatsApp을 연결하면 OpenClaw가 임의의 연락처에 메시지를 보내나요?**  
아니요. 기본 다이렉트 메시지 정책은 **페어링**이므로, 알 수 없는 발신자는 페어링 코드만 받고 메시지는 **처리되지 않습니다**. OpenClaw는 수신한 채팅에만 답장하거나, 사용자가 명시적으로 트리거한 전송(에이전트/CLI)에만 응답합니다.

**WhatsApp에서 페어링은 어떻게 작동하나요?**  
페어링은 알 수 없는 발신자를 위한 다이렉트 메시지 게이트입니다:

- 새 발신자의 첫 다이렉트 메시지는 짧은 코드를 반환합니다(메시지는 처리되지 않음).
- 다음으로 승인합니다: `openclaw pairing approve whatsapp <code>` (`openclaw pairing list whatsapp`로 목록 확인).
- 코드는 1시간 후 만료되며, 대기 요청은 채널당 최대 3개로 제한됩니다.

**하나의 WhatsApp 번호에서 여러 사람이 서로 다른 OpenClaw 인스턴스를 사용할 수 있나요?**  
예, `bindings`를 통해 각 발신자를 서로 다른 에이전트로 라우팅하면 됩니다(피어 `kind: "dm"`, 발신자 E.164 예: `+15551234567`). 답장은 **같은 WhatsApp 계정**에서 오며, 다이렉트 채팅은 각 에이전트의 메인 세션으로 합쳐지므로 **사람당 하나의 에이전트**를 사용하십시오. 다이렉트 메시지 접근 제어(`dmPolicy`/`allowFrom`)는 WhatsApp 계정별 전역 설정입니다. [Multi-Agent Routing](/concepts/multi-agent)을 참고하십시오.

**마법사에서 왜 전화번호를 묻나요?**  
마법사는 본인 다이렉트 메시지를 허용하도록 **허용 목록/소유자**를 설정하는 데 사용합니다. 자동 전송에는 사용되지 않습니다. 개인 WhatsApp 번호로 실행하는 경우 동일한 번호를 사용하고 `channels.whatsapp.selfChatMode`을 활성화하십시오.

## 메시지 정규화 (모델이 보는 내용)

- `Body`는 봉투를 포함한 현재 메시지 본문입니다.
- 인용된 답장 컨텍스트는 **항상 추가**됩니다:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- 답장 메타데이터도 설정됩니다:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = 인용된 본문 또는 미디어 플레이스홀더
  - `ReplyToSender` = 알려진 경우 E.164
- 미디어만 있는 인바운드 메시지는 플레이스홀더를 사용합니다:
  - `<media:image|video|audio|document|sticker>`

## 그룹

- 그룹은 `agent:<agentId>:whatsapp:group:<jid>` 세션으로 매핑됩니다.
- 그룹 정책: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (기본값 `allowlist`).
- 활성화 모드:
  - `mention` (기본값): @멘션 또는 정규식 일치가 필요합니다.
  - `always`: 항상 트리거됩니다.
- `/activation mention|always`은 소유자 전용이며 단독 메시지로 전송되어야 합니다.
- 소유자 = `channels.whatsapp.allowFrom` (미설정 시 자기 자신 E.164).
- **히스토리 주입** (대기 중만):
  - 최근 _처리되지 않은_ 메시지(기본 50개)가 다음 아래에 삽입됩니다:
    `[Chat messages since your last reply - for context]` (이미 세션에 있는 메시지는 재주입되지 않음)
  - 현재 메시지는 다음 아래에 삽입됩니다:
    `[Current message - respond to this]`
  - 발신자 접미사가 추가됩니다: `[from: Name (+E164)]`
- 그룹 메타데이터는 5분간 캐시됩니다(제목 + 참여자).

## 답장 전달 (스레딩)

- WhatsApp Web은 표준 메시지를 전송합니다(현재 Gateway에서는 인용 답장 스레딩을 지원하지 않음).
- 이 채널에서는 답장 태그가 무시됩니다.

## 수신 확인 리액션 (수신 즉시 자동 반응)

WhatsApp은 메시지 수신 즉시, 봇이 답장을 생성하기 전에 이모지 리액션을 자동으로 보낼 수 있습니다. 이는 사용자에게 메시지가 수신되었음을 즉시 알려줍니다.

**구성:**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**옵션:**

- `emoji` (문자열): 수신 확인에 사용할 이모지(예: "👀", "✅", "📨"). 비어 있거나 생략 시 기능 비활성화.
- `direct` (불리언, 기본값: `true`): 다이렉트/DM 채팅에서 리액션 전송.
- `group` (문자열, 기본값: `"mentions"`): 그룹 채팅 동작:
  - `"always"`: 모든 그룹 메시지에 반응(@멘션 없이도)
  - `"mentions"`: 봇이 @멘션된 경우에만 반응
  - `"never"`: 그룹에서는 반응하지 않음

**계정별 오버라이드:**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**동작 참고 사항:**

- 리액션은 타이핑 표시나 봇 답장 이전에, 메시지 수신 즉시 **즉시** 전송됩니다.
- `requireMention: false` (활성화: 항상)인 그룹에서는 `group: "mentions"`가 모든 메시지에 반응합니다(@멘션만이 아님).
- 파이어 앤 포겟: 리액션 실패는 로그에 기록되지만 봇 답장을 방해하지 않습니다.
- 그룹 리액션에는 참여자 JID가 자동으로 포함됩니다.
- WhatsApp은 `messages.ackReaction`을 무시하므로, 대신 `channels.whatsapp.ackReaction`을 사용하십시오.

## 에이전트 도구 (리액션)

- 도구: `whatsapp`와 `react` 액션(`chatJid`, `messageId`, `emoji`, 선택 사항 `remove`).
- 선택 사항: `participant` (그룹 발신자), `fromMe` (자신의 메시지에 반응), `accountId` (멀티 계정).
- 리액션 제거 의미론: [/tools/reactions](/tools/reactions)을 참고하십시오.
- 도구 게이팅: `channels.whatsapp.actions.reactions` (기본값: 활성화).

## 제한

- 아웃바운드 텍스트는 `channels.whatsapp.textChunkLimit`로 청크 처리됩니다(기본값 4000).
- 선택적 줄바꿈 청크 처리: `channels.whatsapp.chunkMode="newline"`을 설정하면 길이 기준 청크 처리 전에 빈 줄(문단 경계) 기준으로 분할합니다.
- 인바운드 미디어 저장은 `channels.whatsapp.mediaMaxMb`으로 제한됩니다(기본값 50 MB).
- 아웃바운드 미디어 항목은 `agents.defaults.mediaMaxMb`으로 제한됩니다(기본값 5 MB).

## 아웃바운드 전송 (텍스트 + 미디어)

- 활성 웹 리스너를 사용하며, Gateway가 실행 중이 아니면 오류가 발생합니다.
- 텍스트 청크 처리: 메시지당 최대 4k( `channels.whatsapp.textChunkLimit`로 구성 가능, 선택 사항 `channels.whatsapp.chunkMode`).
- 미디어:
  - 이미지/비디오/오디오/문서 지원.
  - 오디오는 PTT로 전송되며, `audio/ogg` ⇒ `audio/ogg; codecs=opus`.
  - 캡션은 첫 번째 미디어 항목에만 포함됩니다.
  - 미디어 가져오기는 HTTP(S) 및 로컬 경로를 지원합니다.
  - 애니메이션 GIF: WhatsApp은 인라인 루프를 위해 `gifPlayback: true`가 있는 MP4를 기대합니다.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: `send` 매개변수에 `gifPlayback: true` 포함

## 음성 노트 (PTT 오디오)

WhatsApp은 오디오를 **음성 노트**(PTT 버블)로 전송합니다.

- 최적 결과: OGG/Opus. OpenClaw는 `audio/ogg`을 `audio/ogg; codecs=opus`로 재작성합니다.
- `[[audio_as_voice]]`는 WhatsApp에서 무시됩니다(오디오는 이미 음성 노트로 전송됨).

## 미디어 제한 + 최적화

- 기본 아웃바운드 제한: 미디어 항목당 5 MB.
- 오버라이드: `agents.defaults.mediaMaxMb`.
- 이미지는 제한 이하의 JPEG로 자동 최적화됩니다(리사이즈 + 품질 스윕).
- 초과 미디어 ⇒ 오류; 미디어 답장은 텍스트 경고로 대체됩니다.

## 하트비트

- **Gateway 하트비트**는 연결 상태를 로그합니다(`web.heartbeatSeconds`, 기본 60초).
- **에이전트 하트비트**는 에이전트별로 `agents.list[].heartbeat` 또는 전역으로
  `agents.defaults.heartbeat`을 통해 구성할 수 있습니다(에이전트별 항목이 없을 때 대체).
  - 구성된 하트비트 프롬프트(기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK` 건너뛰기 동작을 사용합니다.
  - 전달은 기본적으로 마지막으로 사용된 채널(또는 구성된 대상)로 이뤄집니다.

## 재연결 동작

- 백오프 정책: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- maxAttempts에 도달하면 웹 모니터링이 중지됩니다(열화 상태).
- 로그아웃됨 ⇒ 중지 후 재연결 필요.

## 구성 빠른 맵

- `channels.whatsapp.dmPolicy` (다이렉트 메시지 정책: pairing/allowlist/open/disabled).
- `channels.whatsapp.selfChatMode` (동일 휴대폰 설정; 봇이 개인 WhatsApp 번호를 사용).
- `channels.whatsapp.allowFrom` (다이렉트 메시지 허용 목록). WhatsApp은 E.164 전화번호를 사용합니다(사용자명 없음).
- `channels.whatsapp.mediaMaxMb` (인바운드 미디어 저장 제한).
- `channels.whatsapp.ackReaction` (메시지 수신 시 자동 리액션: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (계정별 설정 + 선택 사항 `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (계정별 인바운드 미디어 제한).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (계정별 수신 확인 리액션 오버라이드).
- `channels.whatsapp.groupAllowFrom` (그룹 발신자 허용 목록).
- `channels.whatsapp.groupPolicy` (그룹 정책).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (그룹 히스토리 컨텍스트; `0`는 비활성화).
- `channels.whatsapp.dmHistoryLimit` (사용자 턴 기준 다이렉트 메시지 히스토리 제한). 사용자별 오버라이드: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (그룹 허용 목록 + 멘션 게이팅 기본값; 모두 허용하려면 `"*"` 사용)
- `channels.whatsapp.actions.reactions` (WhatsApp 도구 리액션 게이트).
- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (인바운드 접두어; 계정별: `channels.whatsapp.accounts.<accountId>.messagePrefix`; 사용 중단: `messages.messagePrefix`)
- `messages.responsePrefix` (아웃바운드 접두어)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (선택적 오버라이드)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (에이전트별 오버라이드)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (false일 때 채널 시작 비활성화)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## 로그 + 문제 해결

- 하위 시스템: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- 로그 파일: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (구성 가능).
- 문제 해결 가이드: [Gateway 문제 해결](/gateway/troubleshooting).

## 문제 해결 (빠른)

**연결되지 않음 / QR 로그인 필요**

- 증상: `channels status`에 `linked: false`가 표시되거나 'Not linked' 경고가 나타납니다.
- 해결: Gateway 호스트에서 `openclaw channels login`을 실행하고 QR을 스캔하십시오(WhatsApp → 설정 → 연결된 기기).

**연결됨 그러나 연결 끊김 / 재연결 루프**

- 증상: `channels status`에 `running, disconnected`가 표시되거나 'Linked but disconnected' 경고가 나타납니다.
- 해결: `openclaw doctor` (또는 Gateway 재시작). 지속되면 `channels login`로 재연결하고 `openclaw logs --follow`를 점검하십시오.

**Bun 런타임**

- Bun은 **권장되지 않습니다**. WhatsApp(Baileys)과 Telegram은 Bun에서 신뢰성이 낮습니다.  
  **Node**로 Gateway를 실행하십시오. (시작하기의 런타임 참고 사항 참조.)
