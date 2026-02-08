---
read_when:
    - WhatsApp/웹 채널 동작 또는 받은 편지함 라우팅 작업 중
summary: 'WhatsApp(웹 채널) 통합: 로그인, 받은 편지함, 답장, 미디어 및 운영'
title: 왓츠앱
x-i18n:
    generated_at: "2026-02-08T15:52:15Z"
    model: gtx
    provider: google-translate
    source_hash: 9f7acdf2c71819aef426ce63c76d1d43cf9d87eb3c23ddfc8a7ed29aed601d58
    source_path: channels/whatsapp.md
    workflow: 15
---

# WhatsApp(웹 채널)

상태: Baileys를 통한 WhatsApp 웹만 가능합니다. 게이트웨이가 세션을 소유합니다.

## 빠른 설정(초보자)

1. 사용 **별도의 전화번호** 가능하다면(권장).
2. WhatsApp 구성 `~/.openclaw/openclaw.json`.
3. 달리다 `openclaw channels login` QR 코드(연결된 장치)를 스캔합니다.
4. 게이트웨이를 시작하십시오.

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

- 하나의 게이트웨이 프로세스에 여러 WhatsApp 계정(다중 계정)이 있습니다.
- 결정적 라우팅: 모델 라우팅 없이 WhatsApp으로 응답이 반환됩니다.
- 모델은 인용된 답변을 이해하는 데 충분한 컨텍스트를 확인합니다.

## 구성 쓰기

기본적으로 WhatsApp은 다음에 의해 트리거되는 구성 업데이트를 작성할 수 있습니다. `/config set|unset` (요구 `commands.config: true`).

다음을 사용하여 비활성화:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## 건축(누가 무엇을 소유하는가)

- **게이트웨이** Baileys 소켓과 받은 편지함 루프를 소유하고 있습니다.
- **CLI/macOS 앱** 게이트웨이와 대화하세요. Baileys를 직접 사용하지 않습니다.
- **활성 청취자** 아웃바운드 전송에 필요합니다. 그렇지 않으면 보내기가 빨리 실패합니다.

## 전화번호 받기(두 가지 모드)

WhatsApp에서는 인증을 위해 실제 휴대폰 번호가 필요합니다. VoIP 및 가상번호는 일반적으로 차단됩니다. WhatsApp에서 OpenClaw를 실행하는 방법에는 두 가지가 지원됩니다.

### 전용번호(권장)

사용 **별도의 전화번호** OpenClaw용. 최고의 UX, 깔끔한 라우팅, 셀프 채팅 문제 없음. 이상적인 설정: **예비/오래된 Android 휴대전화 + eSIM**. Wi-Fi와 전원을 켜두고 QR을 통해 연결하세요.

**WhatsApp 비즈니스:** 동일한 기기에서 다른 번호로 WhatsApp Business를 사용할 수 있습니다. 개인 WhatsApp을 별도로 보관하는 데 적합합니다. WhatsApp Business를 설치하고 거기에 OpenClaw 번호를 등록하세요.

**샘플 구성(전용 번호, 단일 사용자 허용 목록):**

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

**페어링 모드(옵션):**
허용 목록 대신 페어링을 원할 경우 다음을 설정하세요. `channels.whatsapp.dmPolicy` 에게 `pairing`. 알 수 없는 발신자는 페어링 코드를 받습니다. 다음으로 승인하세요:
`openclaw pairing approve whatsapp <code>`

### 개인 번호(대체)

빠른 대체: 다음에서 OpenClaw 실행 **나만의 전화번호**. 연락처에 스팸을 보내지 않도록 테스트를 위해 자신에게 메시지를 보내세요(WhatsApp의 "자신에게 메시지 보내기"). 설정 및 실험 중에 기본 전화에서 인증 코드를 읽어야 합니다. **셀프 채팅 모드를 활성화해야 합니다.**
마법사가 개인 WhatsApp 번호를 묻는 경우 보조 번호가 아닌 메시지를 보낼 전화(소유자/발신자)를 입력하세요.

**샘플 구성(개인 번호, 셀프 채팅):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

셀프 채팅 답변의 기본값은 다음과 같습니다. `[{identity.name}]` 설정 시(그렇지 않으면 `[openclaw]`)
만약에 `messages.responsePrefix` 설정되지 않았습니다. 사용자 정의하거나 비활성화하려면 명시적으로 설정하십시오.
접두사(사용 `""` 제거하려면).

### 번호 소싱 팁

- **로컬 eSIM** 해당 국가의 이동통신사에서 제공(가장 신뢰할 수 있음)
  - 오스트리아: [hot.at](https://www.hot.at)
  - 영국: [기프개프](https://www.giffgaff.com) — 무료 SIM, 약정 없음
- **선불 SIM** — 저렴합니다. 확인을 위해 SMS 한 번만 받으면 됩니다.

**피하다:** TextNow, Google Voice, 대부분의 "무료 SMS" 서비스 — WhatsApp은 이러한 서비스를 적극적으로 차단합니다.

**팁:** 해당 번호는 확인 SMS를 한 번만 수신하면 됩니다. 그 후 WhatsApp 웹 세션은 다음을 통해 지속됩니다. `creds.json`.

## 왜 Twilio가 아닌가?

- 초기 OpenClaw 빌드는 Twilio의 WhatsApp Business 통합을 지원했습니다.
- WhatsApp 비즈니스 번호는 개인 비서에게는 적합하지 않습니다.
- Meta는 24시간 응답 창을 시행합니다. 지난 24시간 동안 응답하지 않은 경우 해당 업체 전화번호로 새 메시지를 보낼 수 없습니다.
- 대량 또는 "수다스러운" 사용은 공격적인 차단을 유발합니다. 비즈니스 계정은 수십 개의 개인 비서 메시지를 보내도록 설계되지 않았기 때문입니다.
- 결과: 신뢰할 수 없는 전달과 빈번한 차단으로 인해 지원이 제거되었습니다.

## 로그인 + 자격 증명

- 로그인 명령: `openclaw channels login` (연결된 장치를 통한 QR)
- 다중 계정 로그인: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- 기본 계정( `--account` 생략됨): `default` 있는 경우 그렇지 않은 경우 처음으로 구성된 계정 ID(정렬됨)입니다.
- 다음에 저장된 자격 증명 `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- 백업 복사본 위치 `creds.json.bak` (손상 시 복원됨).
- 레거시 호환성: 이전 설치에서는 Baileys 파일이 직접 저장되었습니다. `~/.openclaw/credentials/`.
- 로그아웃: `openclaw channels logout` (또는 `--account <id>`) WhatsApp 인증 상태를 삭제하지만 공유는 유지합니다. `oauth.json`).
- 로그아웃된 소켓 => 오류로 인해 재링크가 지시됩니다.

## 인바운드 흐름(DM + 그룹)

- WhatsApp 이벤트는 다음에서 제공됩니다. `messages.upsert` (베일리스).
- 테스트/재시작 시 이벤트 핸들러가 누적되는 것을 방지하기 위해 종료 시 받은 편지함 리스너가 분리됩니다.
- 상태/방송 채팅은 무시됩니다.
- 직접 채팅은 E.164를 사용합니다. 그룹은 그룹 JID를 사용합니다.
- **DM 정책**: `channels.whatsapp.dmPolicy` 직접 채팅 액세스를 제어합니다(기본값: `pairing`).
  - 페어링: 알 수 없는 발신자가 페어링 코드를 받습니다(다음을 통해 승인). `openclaw pairing approve whatsapp <code>`; 코드는 1시간 후에 만료됩니다.)
  - 개방형: 필요 `channels.whatsapp.allowFrom` 포함하다 `"*"`.
  - 연결된 WhatsApp 번호는 암시적으로 신뢰할 수 있으므로 본인 메시지는 건너뜁니다. ⁠`channels.whatsapp.dmPolicy` 그리고 `channels.whatsapp.allowFrom` 체크 무늬.

### 개인 번호 모드(대체)

OpenClaw를 실행하는 경우 **개인 WhatsApp 번호**, 할 수 있게 하다 `channels.whatsapp.selfChatMode` (위의 샘플 참조)

행동:

- 아웃바운드 DM은 페어링 응답을 트리거하지 않습니다(연락처 스팸 방지).
- 인바운드 알 수 없는 발신자가 계속 팔로우됩니다. `channels.whatsapp.dmPolicy`.
- 셀프 채팅 모드(allowFrom에 귀하의 번호가 포함됨)는 자동 읽기 확인을 방지하고 멘션 JID를 무시합니다.
- 자체 채팅이 아닌 DM에 대해 읽음 확인이 전송됩니다.

## 읽음 확인

기본적으로 게이트웨이는 인바운드 WhatsApp 메시지가 승인되면 읽음(파란색 체크 표시)으로 표시합니다.

전역적으로 비활성화:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

계정당 비활성화:

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

- 셀프 채팅 모드에서는 항상 읽음 확인을 건너뜁니다.

## WhatsApp FAQ: 메시지 보내기 + 페어링

**WhatsApp을 연결하면 OpenClaw가 무작위 연락처에 메시지를 보내나요?**  
아니요. 기본 DM 정책은 다음과 같습니다. **편성**, 알 수 없는 발신자는 페어링 코드만 받게 되며 해당 메시지는 다음과 같습니다. **처리되지 않음**. OpenClaw는 수신한 채팅에만 응답하거나 명시적으로 트리거한 메시지(에이전트/CLI)를 보내는 경우에만 응답합니다.

**WhatsApp에서 페어링은 어떻게 작동하나요?**  
페어링은 알 수 없는 발신자를 위한 DM 게이트입니다.

- 새로운 발신자의 첫 번째 DM은 단축 코드를 반환합니다(메시지는 처리되지 않음).
- 다음으로 승인하세요: `openclaw pairing approve whatsapp <code>` (다음과 함께 나열 `openclaw pairing list whatsapp`).
- 코드는 1시간 후에 만료됩니다. 보류 중인 요청은 채널당 3개로 제한됩니다.

**하나의 WhatsApp 번호에서 여러 사람이 서로 다른 OpenClaw 인스턴스를 사용할 수 있습니까?**  
예, 다음을 통해 각 발신자를 다른 상담원에게 라우팅하면 됩니다. `bindings` (또래 `kind: "dm"`, 발신자 E.164 좋아요 `+15551234567`). 답변은 여전히 ​​​​에서 옵니다. **동일한 WhatsApp 계정**, 직접 채팅은 각 상담원의 기본 세션으로 축소되므로 **1인당 에이전트 1명**. DM접근제어(`dmPolicy`/`allowFrom`)은 WhatsApp 계정별로 전 세계적으로 적용됩니다. 보다 [다중 에이전트 라우팅](/concepts/multi-agent).

**마법사에서 내 전화번호를 묻는 이유는 무엇입니까?**  
마법사는 이를 사용하여 **허용 목록/소유자** 그래서 당신의 DM이 허용됩니다. 자동전송에는 사용되지 않습니다. 개인 WhatsApp 번호로 실행하는 경우 동일한 번호를 사용하고 활성화하십시오. `channels.whatsapp.selfChatMode`.

## 메시지 정규화(모델이 보는 것)

- `Body` 봉투가 포함된 현재 메시지 본문입니다.
- 인용된 응답 컨텍스트는 다음과 같습니다. **항상 추가됨**: 

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- 응답 메타데이터도 설정되었습니다.
  - `ReplyToId` = 스탠자 ID
  - `ReplyToBody` = 인용된 본문 또는 미디어 자리 표시자
  - `ReplyToSender` = 알려진 경우 E.164
- 미디어 전용 인바운드 메시지는 자리 표시자를 사용합니다.
  - `<media:image|video|audio|document|sticker>`

## 여러 떼

- 그룹은 다음에 매핑됩니다. `agent:<agentId>:whatsapp:group:<jid>` 세션.
- 그룹 정책: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (기본 `allowlist`).
- 활성화 모드:
  - `mention` (기본값): @mention 또는 정규식 일치가 필요합니다.
  - `always`: 항상 트리거됩니다.
- `/activation mention|always` 소유자 전용이며 독립형 메시지로 전송되어야 합니다.
- 소유자 = `channels.whatsapp.allowFrom` (또는 설정되지 않은 경우 자체 E.164).
- **역사 주입** (보류 중인 경우에만 해당):
  - 최근의 _처리되지 않은_ 아래에 삽입된 메시지(기본값 50):
    `[Chat messages since your last reply - for context]` (이미 세션에 있는 메시지는 다시 삽입되지 않습니다.)
  - 현재 메시지:
    `[Current message - respond to this]`
  - 보낸 사람 접미사 추가됨: `[from: Name (+E164)]`
- 그룹 메타데이터는 5분 동안 캐시됩니다(주체 + 참가자).

## 답장 전달(스레딩)

- WhatsApp Web은 표준 메시지를 보냅니다(현재 게이트웨이에는 인용된 응답 스레드가 없습니다).
- 이 채널에서는 답글 태그가 무시됩니다.

## 승인 반응(수신 시 자동 반응)

WhatsApp은 봇이 답장을 생성하기 전에 수신 메시지를 수신하는 즉시 자동으로 이모티콘 반응을 보낼 수 있습니다. 이는 사용자에게 메시지가 수신되었다는 즉각적인 피드백을 제공합니다.

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

- `emoji` (문자열): 확인에 사용할 이모티콘입니다(예: "USB", "✅", "📨"). 비어 있거나 생략됨 = 기능이 비활성화되었습니다.
- `direct` (부울, 기본값: `true`): 직접/DM 채팅으로 반응을 보냅니다.
- `group` (문자열, 기본값: `"mentions"`): 그룹 채팅 동작:
  - `"always"`: 모든 그룹 메시지에 반응합니다(@멘션 없이도 가능).
  - `"mentions"`: 봇이 @멘션된 경우에만 반응합니다.
  - `"never"`: 집단으로 반응하지 마십시오

**계정별 재정의:**

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

**행동 참고사항:**

- 반응이 전송됩니다 **즉시** 메시지 수신 시 표시기나 봇 응답을 입력하기 전.
- 다음과 같은 그룹에서 `requireMention: false` (활성화: 항상), `group: "mentions"` @멘션뿐만 아니라 모든 메시지에 반응합니다.
- Fire-and-forget: 반응 실패가 기록되지만 봇의 응답을 방해하지는 않습니다.
- 참가자 JID는 그룹 반응에 자동으로 포함됩니다.
- WhatsApp은 무시합니다 `messages.ackReaction`; 사용 `channels.whatsapp.ackReaction` 대신에.

## 에이전트 도구(반응)

- 도구: `whatsapp` ~와 함께 `react` 행동 (`chatJid`, `messageId`, `emoji`, 선택사항 `remove`).
- 선택 과목: `participant` (그룹 발신자), `fromMe` (자신의 메시지에 반응), `accountId` (다중 계정).
- 반응 제거 의미: 참조 [/도구/반응](/tools/reactions).
- 도구 게이팅: `channels.whatsapp.actions.reactions` (기본값: 활성화됨).

## 제한

- 아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.whatsapp.textChunkLimit` (기본값은 4000).
- 선택적 개행 청킹: 설정 `channels.whatsapp.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- 인바운드 미디어 저장은 다음으로 제한됩니다. `channels.whatsapp.mediaMaxMb` (기본값 50MB)
- 아웃바운드 미디어 항목은 다음으로 제한됩니다. `agents.defaults.mediaMaxMb` (기본값 5MB)

## 아웃바운드 전송(문자 + 미디어)

- 활성 웹 수신기를 사용합니다. 게이트웨이가 실행되지 않으면 오류가 발생합니다.
- 텍스트 청킹: 메시지당 최대 4k(다음을 통해 구성 가능) `channels.whatsapp.textChunkLimit`, 선택사항 `channels.whatsapp.chunkMode`).
- 메디아:
  - 이미지/비디오/오디오/문서가 지원됩니다.
  - PTT로 전송된 오디오. `audio/ogg` => `audio/ogg; codecs=opus`.
  - 첫 번째 미디어 항목에만 캡션이 있습니다.
  - 미디어 가져오기는 HTTP(S) 및 로컬 경로를 지원합니다.
  - 애니메이션 GIF: WhatsApp에서는 MP4를 기대합니다. `gifPlayback: true` 인라인 루핑용.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - 게이트웨이: `send` 매개변수에는 다음이 포함됩니다. `gifPlayback: true`

## 음성 메모(PTT 오디오)

WhatsApp은 오디오를 다음과 같이 보냅니다. **음성 메모** (PTT 버블).

- 최상의 결과: OGG/Opus. OpenClaw 재작성 `audio/ogg` 에게 `audio/ogg; codecs=opus`.
- `[[audio_as_voice]]` WhatsApp에서는 무시됩니다(오디오는 이미 음성 메모로 제공됨).

## 미디어 제한 + 최적화

- 기본 아웃바운드 한도: 5MB(미디어 항목당)
- 보수: `agents.defaults.mediaMaxMb`.
- 이미지는 한도 내에서 JPEG로 자동 최적화됩니다(크기 조정 + 품질 스윕).
- 대형 미디어 => 오류; 미디어 응답은 텍스트 경고로 돌아갑니다.

## 심장 박동

- **게이트웨이 하트비트** 연결 상태를 기록합니다(`web.heartbeatSeconds`, 기본값은 60초).
- **에이전트 하트비트** 에이전트별로 구성 가능(`agents.list[].heartbeat`) 또는 전 세계적으로
  통해 `agents.defaults.heartbeat` (에이전트별 항목이 설정되지 않은 경우 대체).
  - 구성된 하트비트 프롬프트를 사용합니다(기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK` 건너 뛰기 동작.
  - 기본적으로 마지막으로 사용된 채널(또는 구성된 대상)로 전달됩니다.

## 다시 연결 동작

- 백오프 정책: `web.reconnect`: 
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- maxAttempts에 도달하면 웹 모니터링이 중지됩니다(성능 저하).
- 로그아웃 => 중지하고 다시 연결해야 합니다.

## 빠른 지도 구성

- `channels.whatsapp.dmPolicy` (DM 정책: 페어링/허용 목록/열기/비활성화)
- `channels.whatsapp.selfChatMode` (동일한 전화 설정, 봇은 개인 WhatsApp 번호를 사용합니다).
- `channels.whatsapp.allowFrom` (DM 허용 목록). WhatsApp은 E.164 전화번호를 사용합니다(사용자 이름 없음).
- `channels.whatsapp.mediaMaxMb` (인바운드 미디어 저장 한도).
- `channels.whatsapp.ackReaction` (메시지 수신 시 자동 반응: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (계정별 설정 + 선택사항 `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (계정당 인바운드 미디어 한도).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (계정별 승인 반응 재정의)
- `channels.whatsapp.groupAllowFrom` (그룹 발신자 허용 목록).
- `channels.whatsapp.groupPolicy` (그룹 정책).
- `channels.whatsapp.historyLimit`/`channels.whatsapp.accounts.<accountId>.historyLimit` (그룹 역사 맥락; `0` 비활성화).
- `channels.whatsapp.dmHistoryLimit` (사용자 턴의 DM 기록 제한). 사용자별 재정의: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (그룹 허용 목록 + 게이팅 기본값 언급, 사용 `"*"` 모두 허용하려면)
- `channels.whatsapp.actions.reactions` (게이트 WhatsApp 도구 반응).
- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (인바운드 접두사, 계정별: `channels.whatsapp.accounts.<accountId>.messagePrefix`; 더 이상 사용되지 않음: `messages.messagePrefix`)
- `messages.responsePrefix` (아웃바운드 접두사)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (선택적 재정의)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (에이전트별 재정의)
- `session.*` (범위, 유휴, 저장소, mainKey)
- `web.enabled` (false인 경우 채널 시작 비활성화)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## 로그 + 문제 해결

- 하위 시스템: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- 로그 파일: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (구성 가능).
- 문제 해결 가이드: [게이트웨이 문제 해결](/gateway/troubleshooting).

## 문제 해결(빠른)

**연결되지 않음 / QR 로그인 필요**

- 징후: `channels status` 쇼 `linked: false` 또는 "연결되지 않음"이라고 경고합니다.
- 수정: 실행 `openclaw channels login` 게이트웨이 호스트에서 QR을 스캔합니다(WhatsApp → 설정 → 연결된 장치).

**연결되었지만 연결이 끊어짐/재연결 루프**

- 징후: `channels status` 쇼 `running, disconnected` 또는 "연결되었지만 연결이 끊어졌습니다"라는 경고가 표시됩니다.
- 고치다: `openclaw doctor` (또는 게이트웨이를 다시 시작하십시오). 지속되면 다음을 통해 다시 연결하세요. `channels login` 그리고 검사하다 `openclaw logs --follow`.

**롤빵 런타임**

- 롤빵은 **권장하지 않음**. WhatsApp(Baileys)과 Telegram은 Bun에서 신뢰할 수 없습니다.
  다음으로 게이트웨이를 실행하세요. **마디**. (시작하기 런타임 노트를 참조하세요.)
