---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
title: "Telegram"
x-i18n:
  source_hash: 94b4702c00c0d477f780040b220b38d4c212c7d5d80e82768af1511de5d2c4c8
---

# 텔레그램(봇 API)

상태: grammY를 통해 봇 DM + 그룹에 대한 프로덕션 준비가 완료되었습니다. 긴 폴링이 기본 모드입니다. 웹훅 모드는 선택 사항입니다.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    텔레그램의 기본 DM 정책은 페어링입니다.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    교차 채널 진단 및 수리 플레이북.
  </Card>
  <Card title="Gateway configuration" icon="settings" href="/gateway/configuration">
    전체 채널 구성 패턴 및 예시
  </Card>
</CardGroup>

## 빠른 설정

<Steps>
  <Step title="Create the bot token in BotFather">
    Telegram을 열고 **@BotFather**와 채팅하세요(핸들이 정확히 `@BotFather`인지 확인하세요).

    `/newbot`를 실행하고 프롬프트에 따라 토큰을 저장합니다.

  </Step>

  <Step title="Configure token and DM policy">

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    환경 대체: `TELEGRAM_BOT_TOKEN=...` (기본 계정만 해당).

  </Step>

  <Step title="Start gateway and approve first DM">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    페어링 코드는 1시간 후에 만료됩니다.

  </Step>

  <Step title="Add the bot to a group">
    그룹에 봇을 추가한 다음 `channels.telegram.groups` 및 `groupPolicy`를 액세스 모델과 일치하도록 설정하세요.
  </Step>
</Steps>

<Note>
토큰 해결 순서는 계정을 기반으로 합니다. 실제로 구성 값은 환경 폴백보다 우선하며 `TELEGRAM_BOT_TOKEN`는 기본 계정에만 적용됩니다.
</Note>

## 텔레그램 측 설정

<AccordionGroup>
  <Accordion title="Privacy mode and group visibility">
    텔레그램 봇은 기본적으로 **프라이버시 모드**로 설정되어 있어 수신할 그룹 메시지가 제한됩니다.

    봇이 모든 그룹 메시지를 확인해야 하는 경우 다음 중 하나를 수행하세요.

    - `/setprivacy`를 통해 개인 정보 보호 모드를 비활성화하거나
    - 봇을 그룹 관리자로 만듭니다.

    개인 정보 보호 모드를 전환할 때 Telegram이 변경 사항을 적용하도록 각 그룹에서 봇을 제거하고 다시 추가하세요.

  </Accordion>

  <Accordion title="Group permissions">
    관리자 상태는 텔레그램 그룹 설정에서 제어됩니다.

    관리 봇은 모든 그룹 메시지를 수신하며 이는 상시 그룹 동작에 유용합니다.

  </Accordion>

  <Accordion title="Helpful BotFather toggles">

    - `/setjoingroups` 그룹 추가를 허용/거부합니다.
    - `/setprivacy` 그룹 가시성 동작

  </Accordion>
</AccordionGroup>

## 접근 제어 및 활성화

<Tabs>
  <Tab title="DM policy">
    `channels.telegram.dmPolicy`는 직접 메시지 액세스를 제어합니다.

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`"*"`를 포함하려면 `allowFrom` 필요)
    - `disabled`

    `channels.telegram.allowFrom`는 숫자 ID와 사용자 이름을 허용합니다. `telegram:` / `tg:` 접두사가 허용되고 정규화됩니다.

    ### 텔레그램 사용자 ID 찾기

    더 안전함(타사 봇 없음):

    1. 봇에게 DM을 보내세요.
    2. `openclaw logs --follow`를 실행합니다.
    3. `from.id`를 읽어보세요.

    공식 Bot API 방법:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    타사 방법(비공개): `@userinfobot` 또는 `@getidsbot`.

  </Tab>

  <Tab title="Group policy and allowlists">
    두 가지 독립적인 컨트롤이 있습니다.

    1. **허용되는 그룹** (`channels.telegram.groups`)
       - `groups` 구성 없음: 모든 그룹 허용
       - `groups` 구성됨: 허용 목록으로 작동합니다(명시적 ID 또는 `"*"`).

    2. **그룹에 허용되는 발신자** (`channels.telegram.groupPolicy`)
       - `open`
       - `allowlist` (기본값)
       - `disabled`

`groupAllowFrom`은 그룹발신자 필터링에 사용됩니다. 설정하지 않으면 텔레그램은 `allowFrom`로 대체됩니다.

    예: 하나의 특정 그룹에 모든 구성원을 허용합니다.

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

  </Tab>

  <Tab title="Mention behavior">
    그룹 답글에는 기본적으로 멘션이 필요합니다.

    언급은 다음에서 올 수 있습니다.

    - 네이티브 `@botusername` 언급, 또는
    - 패턴 언급:
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    세션 수준 명령 토글:

    - `/activation always`
    - `/activation mention`

    이는 세션 상태만 업데이트합니다. 지속성을 위해 구성을 사용하십시오.

    영구 구성 예:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    그룹 채팅 ID 가져오기:

    - `@userinfobot` / `@getidsbot`에게 그룹 메시지 전달
    - 또는 `openclaw logs --follow`에서 `chat.id`를 읽습니다.
    - 또는 Bot API 검사 `getUpdates`

  </Tab>
</Tabs>

## 런타임 동작

- 텔레그램은 게이트웨이 프로세스가 소유합니다.
- 라우팅은 결정적입니다. 텔레그램 인바운드는 텔레그램에 다시 응답합니다(모델은 채널을 선택하지 않습니다).
- 인바운드 메시지는 응답 메타데이터 및 미디어 자리 표시자를 사용하여 공유 채널 봉투로 정규화됩니다.
- 그룹 세션은 그룹 ID로 분리됩니다. 포럼 주제는 `:topic:<threadId>`를 추가하여 주제를 격리시킵니다.
- DM 메시지는 `message_thread_id`를 전달할 수 있습니다. OpenClaw는 스레드 인식 세션 키를 사용하여 이를 라우팅하고 응답을 위해 스레드 ID를 유지합니다.
- 긴 폴링은 채팅별/스레드별 순서를 지정하는 grammY 러너를 사용합니다. 전체 러너 싱크 동시성은 `agents.defaults.maxConcurrent`를 사용합니다.
- Telegram Bot API는 읽기 확인을 지원하지 않습니다(`sendReadReceipts`는 적용되지 않음).

## 기능 참조

<AccordionGroup>
  <Accordion title="Draft streaming in Telegram DMs">
    OpenClaw는 텔레그램 초안 풍선(`sendMessageDraft`)을 통해 부분 응답을 스트리밍할 수 있습니다.

    요구사항:

    - `channels.telegram.streamMode`는 `"off"`가 아닙니다. (기본값: `"partial"`)
    - 비공개 채팅
    - 인바운드 업데이트에는 `message_thread_id`이 포함됩니다.
    - 봇 토픽이 활성화되었습니다. (`getMe().has_topics_enabled`)

    모드:

    - `off`: 초안 스트리밍 없음
    - `partial`: 부분 텍스트의 빈번한 초안 업데이트
    - `block`: `channels.telegram.draftChunk`를 사용하여 청크 초안 업데이트

    `draftChunk` 블록 모드의 기본값은 다음과 같습니다.

    - `minChars: 200`
    - `maxChars: 800`
    - `breakPreference: "paragraph"`

    `maxChars`는 `channels.telegram.textChunkLimit`에 의해 고정됩니다.

    초안 스트리밍은 DM 전용입니다. 그룹/채널은 초안 풍선을 사용하지 않습니다.

    초안 업데이트 대신 초기 실제 텔레그램 메시지를 원하시면 블록 스트리밍(`channels.telegram.blockStreaming: true`)을 사용하세요.

    텔레그램 전용 추론 스트림:

    - `/reasoning stream`는 초안 버블을 생성하는 동안 추론을 보냅니다.
    - 최종 답변은 추리 문자 없이 발송됩니다.

  </Accordion>

  <Accordion title="Formatting and HTML fallback">
    아웃바운드 텍스트는 텔레그램 `parse_mode: "HTML"`을 사용합니다.

    - Markdown-ish 텍스트는 Telegram-safe HTML로 렌더링됩니다.
    - Telegram 구문 분석 실패를 줄이기 위해 원시 모델 HTML이 이스케이프됩니다.
    - Telegram이 구문 분석된 HTML을 거부하면 OpenClaw는 일반 텍스트로 다시 시도합니다.

    링크 미리보기는 기본적으로 활성화되어 있으며 `channels.telegram.linkPreview: false`로 비활성화할 수 있습니다.

  </Accordion>

  <Accordion title="Native commands and custom commands">
    텔레그램 명령 메뉴 등록은 시작 시 `setMyCommands`로 처리됩니다.

    기본 명령 기본값:

    - `commands.native: "auto"`는 텔레그램의 기본 명령을 활성화합니다.

    사용자 정의 명령 메뉴 항목을 추가합니다.

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

    규칙:

    - 이름은 정규화됩니다(`/`로 시작하는 스트립, 소문자).
    - 유효한 패턴: `a-z`, `0-9`, `_`, 길이 `1..32`
    - 사용자 정의 명령은 기본 명령을 무시할 수 없습니다.
    - 충돌/중복은 건너뛰고 기록됩니다.

    참고:

    - 사용자 정의 명령은 메뉴 항목일 뿐입니다. 동작을 자동으로 구현하지 않습니다.
    - 텔레그램 메뉴에 표시되지 않더라도 플러그인/스킬 명령을 입력하면 계속 작동할 수 있습니다.

    기본 명령이 비활성화되면 내장 기능이 제거됩니다. 사용자 정의/플러그인 명령은 구성된 경우 계속 등록될 수 있습니다.

    일반적인 설정 실패:

    - `setMyCommands failed`는 일반적으로 `api.telegram.org`에 대한 아웃바운드 DNS/HTTPS가 차단되었음을 의미합니다.

    ### 장치 페어링 명령(`device-pair` 플러그인)

    `device-pair` 플러그인이 설치되면:

    1. `/pair`는 설정 코드를 생성합니다.
    2. iOS 앱에 코드 붙여넣기
    3. `/pair approve`는 최근 보류 중인 요청을 승인합니다.

    자세한 내용: [페어링](/channels/pairing#pair-via-telegram-recommended-for-ios).

  </Accordion>

  <Accordion title="Inline buttons">
    인라인 키보드 범위를 구성합니다.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    계정별 재정의:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    범위:

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist` (기본값)

    레거시 `capabilities: ["inlineButtons"]`는 `inlineButtons: "all"`에 매핑됩니다.

    메시지 작업 예:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

    콜백 클릭은 텍스트로 상담원에게 전달됩니다.
    `callback_data: <value>`

  </Accordion>

  <Accordion title="Telegram message actions for agents and automation">
    텔레그램 도구 작업에는 다음이 포함됩니다.

    - `sendMessage` (`to`, `content`, 선택 사항 `mediaUrl`, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content`)

    채널 메시지 작업은 인체공학적 별칭(`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`)을 노출합니다.

    게이팅 제어:

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.editMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (기본값: 비활성화)

    반응 제거 의미: [/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="Reply threading tags">
    Telegram은 생성된 출력에서 명시적인 응답 스레딩 태그를 지원합니다.

    - `[[reply_to_current]]`는 트리거 메시지에 응답합니다.
    - `[[reply_to:<id>]]`는 특정 텔레그램 메시지 ID에 응답합니다.

    `channels.telegram.replyToMode`는 처리를 제어합니다.

    - `first` (기본값)
    - `all`
    - `off`

  </Accordion>

  <Accordion title="Forum topics and thread behavior">
    포럼 슈퍼그룹:

    - 주제 세션 키 추가 `:topic:<threadId>`
    - 주제 스레드를 대상으로 답글 및 입력
    - 주제 구성 경로:
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    일반 주제(`threadId=1`) 특수 사례:

    - 메시지 전송 `message_thread_id` 생략 (텔레그램 거부 `sendMessage(...thread_id=1)`)
    - 입력 작업에는 여전히 `message_thread_id`가 포함됩니다.

주제 상속: 주제 항목은 재정의되지 않는 한 그룹 설정을 상속합니다(`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`).

    템플릿 컨텍스트에는 다음이 포함됩니다.

    - `MessageThreadId`
    - `IsForum`

    DM 스레드 동작:

    - `message_thread_id`와의 비공개 채팅은 DM 라우팅을 유지하지만 스레드 인식 세션 키/응답 대상을 사용합니다.

  </Accordion>

  <Accordion title="Audio, video, and stickers">
    ### 오디오 메시지

    텔레그램은 음성 메모와 오디오 파일을 구별합니다.

    - 기본값: 오디오 파일 동작
    - 음성 메모를 강제로 보내려면 상담원 회신에 `[[audio_as_voice]]` 태그를 지정하세요.

    메시지 작업 예:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### 영상 메시지

    텔레그램은 비디오 파일과 비디오 노트를 구별합니다.

    메시지 작업 예:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    비디오 노트는 캡션을 지원하지 않습니다. 제공된 메시지 텍스트는 별도로 전송됩니다.

    ### 스티커

    인바운드 스티커 처리:

    - 정적 WEBP: 다운로드 및 처리됨(자리 표시자 `<media:sticker>`)
    - 애니메이션 TGS: 생략
    - 비디오 WEBM: 건너뛰기

    스티커 컨텍스트 필드:

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    스티커 캐시 파일:

    - `~/.openclaw/telegram/sticker-cache.json`

    스티커는 (가능한 경우) 한 번만 설명되고 캐시되어 반복적인 비전 호출을 줄입니다.

    스티커 작업 활성화:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

    스티커 보내기 작업:

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    캐시된 스티커 검색:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="Reaction notifications">
    텔레그램 반응은 `message_reaction` 업데이트로 도착합니다(메시지 페이로드와는 별도로).

    활성화되면 OpenClaw는 다음과 같은 시스템 이벤트를 대기열에 추가합니다.

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    구성:

    - `channels.telegram.reactionNotifications`: `off | own | all` (기본값: `own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (기본값: `minimal`)

    참고:

    - `own` 봇이 보낸 메시지에 대해서만 사용자 반응을 의미합니다(보낸 메시지 캐시를 통한 최선의 노력).
    - 텔레그램은 반응 업데이트에 스레드 ID를 제공하지 않습니다.
      - 포럼이 아닌 그룹은 그룹 채팅 세션으로 라우팅됩니다.
      - 포럼 그룹은 정확한 원래 주제가 아닌 그룹 일반 주제 세션(`:topic:1`)으로 라우팅됩니다.

    `allowed_updates` 폴링/웹훅에는 `message_reaction`가 자동으로 포함됩니다.

  </Accordion>

  <Accordion title="Config writes from Telegram events and commands">
    채널 구성 쓰기는 기본적으로 활성화되어 있습니다(`configWrites !== false`).

    텔레그램으로 인해 발생하는 쓰기에는 다음이 포함됩니다.

    - `channels.telegram.groups` 업데이트를 위한 그룹 마이그레이션 이벤트(`migrate_to_chat_id`)
    - `/config set` 및 `/config unset` (명령 활성화 필요)

    비활성화:

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Long polling vs webhook">
    기본값: 긴 폴링.

    웹훅 모드:

    - `channels.telegram.webhookUrl` 설정
    - `channels.telegram.webhookSecret` 설정 (웹훅 URL 설정 시 필수)
    - 선택 사항 `channels.telegram.webhookPath` (기본값 `/telegram-webhook`)

    웹훅 모드의 기본 로컬 리스너는 `0.0.0.0:8787`에 바인딩됩니다.

    공용 엔드포인트가 다른 경우 앞에 역방향 프록시를 배치하고 공용 URL에서 `webhookUrl`를 가리킵니다.

  </Accordion>

<Accordion title="Limits, retry, and CLI targets">
    - `channels.telegram.textChunkLimit` 기본값은 4000입니다.
    - `channels.telegram.chunkMode="newline"`는 길이 분할 이전에 단락 경계(빈 줄)를 선호합니다.
    - `channels.telegram.mediaMaxMb` (기본값 5)는 인바운드 텔레그램 미디어 다운로드/처리 크기를 제한합니다.
    - `channels.telegram.timeoutSeconds`는 Telegram API 클라이언트 시간 초과를 무시합니다(설정되지 않은 경우 grammY 기본값이 적용됩니다).
    - 그룹 컨텍스트 기록은 `channels.telegram.historyLimit` 또는 `messages.groupChat.historyLimit`를 사용합니다(기본값 50). `0`는 비활성화됩니다.
    - DM 기록 관리:
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - 아웃바운드 텔레그램 API 재시도는 `channels.telegram.retry`를 통해 구성할 수 있습니다.

    CLI 전송 대상은 숫자 채팅 ID 또는 사용자 이름일 수 있습니다.

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

  </Accordion>
</AccordionGroup>

## 문제 해결

<AccordionGroup>
  <Accordion title="Bot does not respond to non mention group messages">

    - `requireMention=false`인 경우 텔레그램 개인 정보 보호 모드는 전체 공개를 허용해야 합니다.
      - BotFather: `/setprivacy` -> 비활성화
      - 그런 다음 그룹에 봇을 제거하고 다시 추가합니다.
    - `openclaw channels status` 구성에서 언급되지 않은 그룹 메시지가 예상되면 경고합니다.
    - `openclaw channels status --probe`는 명시적인 숫자 그룹 ID를 확인할 수 있습니다. 와일드카드 `"*"`는 멤버십을 검색할 수 없습니다.
    - 빠른 세션 테스트: `/activation always`.

  </Accordion>

  <Accordion title="Bot not seeing group messages at all">

    - `channels.telegram.groups`가 존재할 경우 그룹을 나열해야 합니다(또는 `"*"`를 포함).
    - 그룹 내 봇 멤버십 확인
    - 검토 로그: `openclaw logs --follow` 건너뛰기 이유

  </Accordion>

  <Accordion title="Commands work partially or not at all">

    - 발신자 신원 인증(페어링 및/또는 `allowFrom`)
    - 그룹 정책이 `open`인 경우에도 명령 권한이 계속 적용됩니다.
    - `setMyCommands failed`는 일반적으로 `api.telegram.org`에 대한 DNS/HTTPS 연결 문제를 나타냅니다.

  </Accordion>

  <Accordion title="Polling or network instability">

    - Node 22+ + 사용자 정의 가져오기/프록시는 AbortSignal 유형이 일치하지 않는 경우 즉시 중단 동작을 트리거할 수 있습니다.
    - 일부 호스트는 `api.telegram.org`를 먼저 IPv6로 해결합니다. IPv6 송신이 중단되면 간헐적으로 Telegram API 오류가 발생할 수 있습니다.
    - DNS 답변 확인:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

추가 도움말: [채널 문제 해결](/channels/troubleshooting).

## 텔레그램 구성 참조 포인터

기본 참조:

- [구성 참고 - 텔레그램](/gateway/configuration-reference#telegram)

텔레그램 특정 고신호 필드:

- 시작/인증: `enabled`, `botToken`, `tokenFile`, `accounts.*`
- 접근 제어: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`
- 명령/메뉴: `commands.native`, `customCommands`
- 스레딩/답글: `replyToMode`
- 스트리밍: `streamMode`, `draftChunk`, `blockStreaming`
- 포맷/전달: `textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- 미디어/네트워크: `mediaMaxMb`, `timeoutSeconds`, `retry`, `network.autoSelectFamily`, `proxy`
- 웹훅: `webhookUrl`, `webhookSecret`, `webhookPath`
- 행동/능력: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- 반응: `reactionNotifications`, `reactionLevel`
- 쓰기/기록: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [문제 해결](/channels/troubleshooting)
