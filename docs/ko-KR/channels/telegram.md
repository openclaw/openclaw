---
summary: "Telegram 봇 지원 상태, 기능 및 구성"
read_when:
  - Telegram 기능 또는 webhook 작업 중
title: "Telegram"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/telegram.md
  workflow: 15
---

# Telegram (Bot API)

상태: grammY 를 통한 봇 DM + 그룹용 프로덕션 준비 완료. Long polling 은 기본 모드이며 webhook 모드는 선택 사항입니다.

<CardGroup cols={3}>
  <Card title="페어링" icon="link" href="/channels/pairing">
    Telegram 의 기본 DM 정책은 페어링입니다.
  </Card>
  <Card title="채널 문제 해결" icon="wrench" href="/channels/troubleshooting">
    채널 간 진단 및 복구 플레이북.
  </Card>
  <Card title="Gateway 구성" icon="settings" href="/gateway/configuration">
    전체 채널 구성 패턴 및 예제.
  </Card>
</CardGroup>

## 빠른 설정

<Steps>
  <Step title="BotFather 에서 봇 토큰 생성">
    Telegram 을 열고 **@BotFather** 와 채팅합니다 (핸들이 정확히 `@BotFather` 인지 확인).

    `/newbot` 을 실행하고 프롬프트를 따른 후 토큰을 저장합니다.

  </Step>

  <Step title="토큰 및 DM 정책 구성">

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

    환경 폴백: `TELEGRAM_BOT_TOKEN=...` (기본 계정만).
    Telegram 은 `openclaw channels login telegram` 을 **사용하지 않습니다**. 구성/환경에서 토큰을 구성한 후 gateway 를 시작합니다.

  </Step>

  <Step title="Gateway 시작 및 첫 번째 DM 승인">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    페어링 코드는 1 시간 후 만료됩니다.

  </Step>

  <Step title="그룹에 봇 추가">
    그룹에 봇을 추가한 후 `channels.telegram.groups` 와 `groupPolicy` 를 액세스 모델과 일치하도록 설정합니다.
  </Step>
</Steps>

<Note>
토큰 해석 순서는 계정 인식입니다. 실제로 구성 값이 환경 폴백을 이기며 `TELEGRAM_BOT_TOKEN` 은 기본 계정에만 적용됩니다.
</Note>

## Telegram 측 설정

<AccordionGroup>
  <Accordion title="개인정보 보호 모드 및 그룹 가시성">
    Telegram 봇은 기본적으로 **개인정보 보호 모드** 로 설정되어 받을 수 있는 그룹 메시지를 제한합니다.

    봇이 모든 그룹 메시지를 봐야 하는 경우:

    - `/setprivacy` 를 통해 개인정보 보호 모드 비활성화, 또는
    - 봇을 그룹 관리자로 설정합니다.

    개인정보 보호 모드를 전환할 때 각 그룹에서 봇을 제거 + 다시 추가하여 Telegram 이 변경사항을 적용하도록 합니다.

  </Accordion>

  <Accordion title="그룹 권한">
    관리자 상태는 Telegram 그룹 설정에서 제어됩니다.

    관리자 봇은 모든 그룹 메시지를 받으므로 항상 켜진 그룹 동작에 유용합니다.

  </Accordion>

  <Accordion title="도움이 되는 BotFather 토글">

    - `/setjoingroups` - 그룹 추가 허용/거부
    - `/setprivacy` - 그룹 가시성 동작

  </Accordion>
</AccordionGroup>

## 접근 제어 및 활성화

<Tabs>
  <Tab title="DM 정책">
    `channels.telegram.dmPolicy` 는 직접 메시지 액세스를 제어합니다:

    - `pairing` (기본)
    - `allowlist` (`allowFrom` 에 최소 하나의 발신자 ID 필요)
    - `open` (`allowFrom` 에 `"*"` 포함 필요)
    - `disabled`

    `channels.telegram.allowFrom` 은 숫자 Telegram 사용자 ID를 허용합니다. `telegram:` / `tg:` 접두사는 허용되고 정규화됩니다.
    `dmPolicy: "allowlist"` (빈 `allowFrom` 포함)는 모든 DM을 차단하며 구성 검증에서 거부됩니다.
    온보딩 마법사는 `@username` 입력을 수락하고 숫자 ID로 해석합니다.
    업그레이드했는데 구성에 `@username` 허용 목록 항목이 포함된 경우 `openclaw doctor --fix` 를 실행하여 해석합니다 (최선의 노력. Telegram 봇 토큰 필요).
    이전에 페어링 저장소 허용 목록 파일을 사용했다면 `openclaw doctor --fix` 는 허용 목록 흐름에서 `channels.telegram.allowFrom` 으로 항목을 복구할 수 있습니다 (예: `dmPolicy: "allowlist"` 에 명시적 ID가 아직 없을 때).

    ### Telegram 사용자 ID 찾기

    더 안전함 (제삼자 봇 없음):

    1. 봇에 DM을 보냅니다.
    2. `openclaw logs --follow` 를 실행합니다.
    3. `from.id` 를 읽습니다.

    공식 Bot API 메서드:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    제삼자 메서드 (개인정보 보호 사항 적음): `@userinfobot` 또는 `@getidsbot`.

  </Tab>

  <Tab title="그룹 정책 및 허용 목록">
    두 가지 제어가 함께 적용됩니다:

    1. **어느 그룹이 허용되는지** (`channels.telegram.groups`)
       - `groups` 구성 없음:
         - `groupPolicy: "open"` 이면: 모든 그룹이 그룹 ID 확인을 통과할 수 있음
         - `groupPolicy: "allowlist"` (기본)이면: `groups` 항목을 추가할 때까지 (또는 `"*"`) 그룹이 차단됨
       - `groups` 구성: 허용 목록 역할 (명시적 ID 또는 `"*"`)

    2. **그룹에서 어느 발신자가 허용되는지** (`channels.telegram.groupPolicy`)
       - `open`
       - `allowlist` (기본)
       - `disabled`

    `groupAllowFrom` 은 그룹 발신자 필터링에 사용됩니다. 설정되지 않으면 Telegram 은 `allowFrom` 으로 폴백합니다.
    `groupAllowFrom` 항목은 숫자 Telegram 사용자 ID여야 합니다 (`telegram:` / `tg:` 접두사는 정규화됨).
    숫자가 아닌 항목은 발신자 권한 부여 시 무시됩니다.
    보안 경계 (`2026.2.25+`): 그룹 발신자 인증은 DM 페어링 저장소 승인을 **상속하지 않습니다**.
    페어링은 DM 전용으로 유지됩니다. 그룹의 경우 `groupAllowFrom` 또는 그룹별/토픽별 `allowFrom` 을 설정합니다.
    런타임 참고: `channels.telegram` 이 완전히 누락된 경우 `channels.defaults.groupPolicy` 가 명시적으로 설정되지 않으면 런타임은 실패 폐쇄 `groupPolicy="allowlist"` 로 기본값입니다.

    예: 특정 그룹의 모든 멤버 허용:

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

  <Tab title="언급 동작">
    그룹 회신은 기본적으로 언급이 필요합니다.

    언급은 다음에서 올 수 있습니다:

    - 네이티브 `@botusername` 언급, 또는
    - 다음의 언급 패턴:
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    세션 수준 명령 토글:

    - `/activation always`
    - `/activation mention`

    이는 세션 상태만 업데이트합니다. 지속성을 위해 구성을 사용하세요.

    지속적 구성 예:

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

    그룹 채팅 ID 얻기:

    - 그룹 메시지를 `@userinfobot` / `@getidsbot` 으로 전달
    - 또는 `openclaw logs --follow` 에서 `chat.id` 읽음
    - 또는 Bot API `getUpdates` 검사

  </Tab>
</Tabs>

## 런타임 동작

- Telegram 은 gateway 프로세스가 소유합니다.
- 라우팅은 결정적입니다: Telegram 인바운드는 Telegram 으로 다시 회신합니다 (모델이 채널을 선택하지 않음).
- 인바운드 메시지는 회신 메타데이터 및 미디어 자리 표시자가 있는 공유 채널 봉투로 정규화됩니다.
- 그룹 세션은 그룹 ID로 격리됩니다. 포럼 토픽은 토픽을 격리된 상태로 유지하기 위해 `:topic:<threadId>` 를 추가합니다.
- DM 메시지는 `message_thread_id` 를 전달할 수 있습니다. OpenClaw 는 스레드 인식 세션 키로 라우팅하고 회신에 대해 스레드 ID를 유지합니다.
- Long polling 은 채팅별/스레드별 순서화를 사용하여 grammY 러너를 사용합니다. 전체 러너 싱크 동시성은 `agents.defaults.maxConcurrent` 를 사용합니다.
- Telegram Bot API 는 읽음 확인을 지원하지 않습니다 (`sendReadReceipts` 는 적용되지 않음).

## 기능 참조

<AccordionGroup>
  <Accordion title="라이브 스트림 미리보기 (메시지 편집)">
    OpenClaw 는 임시 Telegram 메시지를 전송하고 텍스트가 도착할 때 편집하여 부분 회신을 스트리밍할 수 있습니다.

    요구 사항:

    - `channels.telegram.streaming` 은 `off | partial | block | progress` (기본: `off`)
    - `progress` 는 Telegram 에서 `partial` 로 매핑됨 (채널 간 네이밍과의 호환성)
    - 레거시 `channels.telegram.streamMode` 및 부울 `streaming` 값은 자동 매핑됨

    이는 직접 채팅 및 그룹/토픽에서 작동합니다.

    텍스트 전용 회신의 경우 OpenClaw 는 동일한 미리보기 메시지를 유지하고 최종 편집을 제자리에서 수행합니다 (두 번째 메시지 없음).

    복잡한 회신 (예: 미디어 페이로드)의 경우 OpenClaw 는 일반 최종 배달로 폴백한 후 미리보기 메시지를 정리합니다.

    미리보기 스트리밍은 블록 스트리밍과 별개입니다. 블록 스트리밍이 Telegram 에 대해 명시적으로 활성화되면 OpenClaw 는 이중 스트리밍을 피하기 위해 미리보기 스트림을 건너뜁니다.

    Telegram 전용 추론 스트림:

    - `/reasoning stream` 은 생성하는 동안 라이브 미리보기로 추론을 보냅니다
    - 최종 답변은 추론 텍스트 없이 전송됩니다

  </Accordion>

  <Accordion title="서식 및 HTML 폴백">
    아웃바운드 텍스트는 Telegram `parse_mode: "HTML"` 을 사용합니다.

    - Markdown 같은 텍스트는 Telegram 안전 HTML 로 렌더링됩니다.
    - 원본 모델 HTML은 Telegram 구문 분석 실패를 줄이기 위해 이스케이프됩니다.
    - Telegram 이 구문 분석된 HTML 을 거부하면 OpenClaw 는 일반 텍스트로 재시도합니다.

    링크 미리보기는 기본적으로 활성화되며 `channels.telegram.linkPreview: false` 로 비활성화할 수 있습니다.

  </Accordion>

  <Accordion title="네이티브 명령 및 사용자 정의 명령">
    Telegram 명령 메뉴 등록은 `setMyCommands` 로 시작 시 처리됩니다.

    네이티브 명령 기본값:

    - `commands.native: "auto"` 는 Telegram 에 대한 네이티브 명령을 활성화합니다

    사용자 정의 명령 메뉴 항목 추가:

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

    - 이름은 정규화됩니다 (선행 `/` 제거, 소문자)
    - 유효한 패턴: `a-z`, `0-9`, `_`, 길이 `1..32`
    - 사용자 정의 명령은 네이티브 명령을 재정의할 수 없습니다
    - 충돌/중복은 건너뛰고 로깅됩니다

    참고:

    - 사용자 정의 명령은 메뉴 항목일 뿐입니다. 동작을 자동으로 구현하지 않습니다
    - Telegram 메뉴에 표시되지 않더라도 입력할 때 플러그인/스킬 명령이 여전히 작동할 수 있습니다

    네이티브 명령이 비활성화되면 기본 제공 명령이 제거됩니다. 사용자 정의/플러그인 명령은 구성된 경우에도 등록될 수 있습니다.

    일반적인 설정 실패:

    - `setMyCommands failed` 는 보통 `api.telegram.org` 로의 아웃바운드 DNS/HTTPS가 차단되었음을 의미합니다.

    ### 장치 페어링 명령 (`device-pair` 플러그인)

    `device-pair` 플러그인이 설치된 경우:

    1. `/pair` 는 설정 코드를 생성합니다
    2. iOS 앱에서 코드를 붙여넣습니다
    3. `/pair approve` 는 최신 대기 중인 요청을 승인합니다

    더 많은 세부 정보: [페어링](/channels/pairing#pair-via-telegram-recommended-for-ios).

  </Accordion>

  <Accordion title="인라인 버튼">
    인라인 키보드 범위 구성:

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
    - `allowlist` (기본)

    레거시 `capabilities: ["inlineButtons"]` 는 `inlineButtons: "all"` 로 매핑됩니다.

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

    콜백 클릭은 에이전트에 텍스트로 전달됩니다:
    `callback_data: <value>`

  </Accordion>

  <Accordion title="에이전트 및 자동화를 위한 Telegram 메시지 작업">
    Telegram 도구 작업에 포함됨:

    - `sendMessage` (`to`, `content`, 선택 사항 `mediaUrl`, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content`)
    - `createForumTopic` (`chatId`, `name`, 선택 사항 `iconColor`, `iconCustomEmojiId`)

    채널 메시지 작업은 인체공학적 별칭을 노출합니다 (`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`, `topic-create`).

    게이팅 제어:

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (기본: 비활성화)

    참고: `edit` 과 `topic-create` 는 현재 기본적으로 활성화되어 있으며 별도의 `channels.telegram.actions.*` 토글이 없습니다.

    반응 제거 의미론: [/tools/reactions](/tools/reactions)

  </Accordion>

  <Accordion title="회신 스레딩 태그">
    Telegram 은 생성된 출력에서 명시적 회신 스레딩 태그를 지원합니다:

    - `[[reply_to_current]]` 는 트리거 메시지에 회신합니다
    - `[[reply_to:<id>]]` 는 특정 Telegram 메시지 ID에 회신합니다

    `channels.telegram.replyToMode` 는 처리를 제어합니다:

    - `off` (기본)
    - `first`
    - `all`

    참고: `off` 는 암시적 회신 스레딩을 비활성화합니다. 명시적 `[[reply_to_*]]` 태그는 여전히 적용됩니다.

  </Accordion>

  <Accordion title="포럼 토픽 및 스레드 동작">
    포럼 수퍼그룹:

    - 토픽 세션 키는 `:topic:<threadId>` 를 추가합니다
    - 회신 및 입력은 토픽 스레드를 대상으로 합니다
    - 토픽 구성 경로:
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    일반 토픽 (`threadId=1`) 특수 사례:

    - 메시지 전송은 `message_thread_id` 를 생략합니다 (Telegram 은 `sendMessage(...thread_id=1)` 를 거부함)
    - 입력 작업은 여전히 `message_thread_id` 를 포함합니다

    토픽 상속: 토픽 항목은 재정의되지 않으면 그룹 설정을 상속합니다 (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`).

    템플릿 컨텍스트에 포함:

    - `MessageThreadId`
    - `IsForum`

    DM 스레드 동작:

    - `message_thread_id` 가 있는 개인 채팅은 DM 라우팅을 유지하지만 스레드 인식 세션 키/회신 대상을 사용합니다.

  </Accordion>

  <Accordion title="오디오, 비디오 및 스티커">
    ### 오디오 메시지

    Telegram 은 음성 노트 vs 오디오 파일을 구분합니다.

    - 기본: 오디오 파일 동작
    - 태그 `[[audio_as_voice]]` 를 에이전트 회신에 사용하여 음성 노트 전송을 강제합니다

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

    ### 비디오 메시지

    Telegram 은 비디오 파일 vs 비디오 노트를 구분합니다.

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

    - 정적 WEBP: 다운로드 및 처리 (자리 표시자 `<media:sticker>`)
    - 애니메이션 TGS: 건너뜀
    - 비디오 WEBM: 건너뜀

    스티커 컨텍스트 필드:

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    스티커 캐시 파일:

    - `~/.openclaw/telegram/sticker-cache.json`

    스티커는 한 번 설명되고 (가능한 경우) 반복 vision 호출을 줄이기 위해 캐시됩니다.

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

    스티커 전송 작업:

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

  <Accordion title="반응 알림">
    Telegram 반응은 `message_reaction` 업데이트로 도착합니다 (메시지 페이로드와는 별개).

    활성화되면 OpenClaw 는 다음과 같은 시스템 이벤트를 대기열에 넣습니다:

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    구성:

    - `channels.telegram.reactionNotifications`: `off | own | all` (기본: `own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (기본: `minimal`)

    참고:

    - `own` 은 봇에서 보낸 메시지에 대한 사용자 반응만 의미합니다 (전송 메시지 캐시를 통한 최선의 노력).
    - 반응 이벤트는 여전히 Telegram 접근 제어를 준수합니다 (`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`). 승인되지 않은 발신자는 삭제됩니다.
    - Telegram 은 반응 업데이트에서 스레드 ID를 제공하지 않습니다.
      - 포럼이 아닌 그룹은 그룹 채팅 세션으로 라우팅됨
      - 포럼 그룹은 정확한 원본 토픽이 아닌 그룹 일반 토픽 세션 (`:topic:1`) 으로 라우팅됨

    polling/webhook 의 `allowed_updates` 는 `message_reaction` 을 자동으로 포함합니다.

  </Accordion>

  <Accordion title="Ack 반응">
    `ackReaction` 은 OpenClaw 가 인바운드 메시지를 처리하는 동안 승인 이모지를 보냅니다.

    해석 순서:

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - 에이전트 신원 이모지 폴백 (`agents.list[].identity.emoji`, 그렇지 않으면 "👀")

    참고:

    - Telegram 은 유니코드 이모지를 예상합니다 (예: "👀").
    - `""` 을 사용하여 채널 또는 계정에 대한 반응을 비활성화합니다.

  </Accordion>

  <Accordion title="Telegram 이벤트 및 명령의 구성 쓰기">
    채널 구성 쓰기는 기본적으로 활성화됩니다 (`configWrites !== false`).

    Telegram 트리거 쓰기에 포함:

    - 그룹 마이그레이션 이벤트 (`migrate_to_chat_id`) - `channels.telegram.groups` 업데이트
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
    기본: long polling.

    Webhook 모드:

    - `channels.telegram.webhookUrl` 설정
    - `channels.telegram.webhookSecret` 설정 (webhook URL 설정 시 필수)
    - 선택 사항 `channels.telegram.webhookPath` (기본 `/telegram-webhook`)
    - 선택 사항 `channels.telegram.webhookHost` (기본 `127.0.0.1`)
    - 선택 사항 `channels.telegram.webhookPort` (기본 `8787`)

    webhook 모드의 기본 로컬 리스너는 `127.0.0.1:8787` 로 바인딩됩니다.

    공개 끝점이 다른 경우 리버스 프록시를 앞에 배치하고 `webhookUrl` 을 공개 URL로 가리킵니다.
    의도적으로 외부 수신이 필요한 경우 `webhookHost` (예: `0.0.0.0`) 을 설정합니다.

  </Accordion>

  <Accordion title="제한, 재시도 및 CLI 대상">
    - `channels.telegram.textChunkLimit` 기본값은 4000입니다.
    - `channels.telegram.chunkMode="newline"` 는 길이 분할 전에 단락 경계 (빈 줄)를 선호합니다.
    - `channels.telegram.mediaMaxMb` (기본 5) - 인바운드 Telegram 미디어 다운로드/처리 크기 제한.
    - `channels.telegram.timeoutSeconds` - Telegram API 클라이언트 타임아웃 재정의 (설정되지 않으면 grammY 기본값 적용).
    - 그룹 컨텍스트 이력은 `channels.telegram.historyLimit` 또는 `messages.groupChat.historyLimit` (기본 50) 을 사용합니다. `0` 은 비활성화.
    - DM 이력 제어:
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - `channels.telegram.retry` 구성은 복구 가능한 아웃바운드 API 오류에 대해 Telegram 전송 도우미 (CLI/도구/작업)에 적용됩니다.

    CLI 전송 대상은 숫자 채팅 ID 또는 사용자 이름일 수 있습니다:

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

  </Accordion>
</AccordionGroup>

## 문제 해결

<AccordionGroup>
  <Accordion title="봇이 mention 이 아닌 그룹 메시지에 응답하지 않음">

    - `requireMention=false` 인 경우 Telegram 개인정보 보호 모드는 완전한 가시성을 허용해야 합니다.
      - BotFather: `/setprivacy` -> 비활성화
      - 그런 다음 그룹에서 봇 제거 + 다시 추가
    - `openclaw channels status` 는 구성이 언급 없는 그룹 메시지를 예상할 때 경고합니다.
    - `openclaw channels status --probe` 는 명시적 숫자 그룹 ID를 확인할 수 있습니다. 와일드카드 `"*"` 는 멤버십 프로브할 수 없습니다.
    - 빠른 세션 테스트: `/activation always`.

  </Accordion>

  <Accordion title="봇이 그룹 메시지를 전혀 보지 못함">

    - `channels.telegram.groups` 이 있을 때 그룹은 나열되어야 합니다 (또는 `"*"` 포함)
    - 그룹의 봇 멤버십 확인
    - 로그 검토: 건너뛴 이유에 대해 `openclaw logs --follow` 확인

  </Accordion>

  <Accordion title="명령이 부분적으로 작동하거나 작동하지 않음">

    - 발신자 신원 권한 부여 (페어링 및/또는 숫자 `allowFrom`)
    - 명령 권한 부여는 그룹 정책이 `open` 인 경우에도 적용됩니다
    - `setMyCommands failed` 는 보통 `api.telegram.org` 로의 DNS/HTTPS 도달 가능성 문제를 나타냅니다

  </Accordion>

  <Accordion title="Polling 또는 네트워크 불안정">

    - Node 22+ + 사용자 정의 fetch/프록시는 AbortSignal 타입 불일치 시 즉시 중단 동작을 트리거할 수 있습니다.
    - 일부 호스트는 `api.telegram.org` 을 IPv6 으로 먼저 해석합니다. 끊어진 IPv6 이그레스는 간헐적 Telegram API 실패를 일으킬 수 있습니다.
    - 로그에 `TypeError: fetch failed` 또는 `Network request for 'getUpdates' failed!` 이 포함된 경우 OpenClaw 는 이제 이를 복구 가능한 네트워크 오류로 재시도합니다.
    - 불안정한 직접 이그레스/TLS 가 있는 VPS 호스트에서 `channels.telegram.proxy` 를 통해 Telegram API 호출을 라우팅합니다:

```yaml
channels:
  telegram:
    proxy: socks5://user:pass@proxy-host:1080
```

    - Node 22+ 은 `autoSelectFamily=true` (WSL2 제외) 및 `dnsResultOrder=ipv4first` 를 기본값으로 합니다.
    - 호스트가 WSL2 이거나 IPv4 전용 동작이 더 잘 작동하는 경우 명시적으로 가족 선택을 강제합니다:

```yaml
channels:
  telegram:
    network:
      autoSelectFamily: false
```

    - 환경 재정의 (임시):
      - `OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY=1`
      - `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`
    - DNS 답변 검증:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

더 많은 도움말: [채널 문제 해결](/channels/troubleshooting).

## Telegram 구성 참조 포인터

주요 참조:

- `channels.telegram.enabled`: 채널 시작 활성화/비활성화.
- `channels.telegram.botToken`: 봇 토큰 (BotFather).
- `channels.telegram.tokenFile`: 파일 경로에서 토큰 읽음.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (기본: pairing).
- `channels.telegram.allowFrom`: DM 허용 목록 (숫자 Telegram 사용자 ID). `allowlist` 는 최소 하나의 발신자 ID 필요. `open` 은 `"*"` 필요. `openclaw doctor --fix` 는 레거시 `@username` 항목을 ID로 해석할 수 있으며 allowlist 마이그레이션 흐름에서 페어링 저장소 파일의 항목을 복구할 수 있습니다.
- `channels.telegram.defaultTo`: 명시적 `--reply-to` 이 제공되지 않을 때 CLI `--deliver` 에서 사용하는 기본 Telegram 대상.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (기본: allowlist).
- `channels.telegram.groupAllowFrom`: 그룹 발신자 허용 목록 (숫자 Telegram 사용자 ID). `openclaw doctor --fix` 는 레거시 `@username` 항목을 ID로 해석할 수 있습니다. 숫자가 아닌 항목은 인증 시 무시됩니다. 그룹 인증은 DM 페어링 저장소 폴백을 사용하지 않습니다 (`2026.2.25+`).
- 다중 계정 우선순위:
  - `channels.telegram.accounts.default.allowFrom` 및 `channels.telegram.accounts.default.groupAllowFrom` 은 `default` 계정에만 적용됩니다.
  - 명명된 계정은 계정 수준 값이 설정되지 않을 때 `channels.telegram.allowFrom` 및 `channels.telegram.groupAllowFrom` 을 상속합니다.
  - 명명된 계정은 `channels.telegram.accounts.default.allowFrom` / `groupAllowFrom` 을 상속하지 않습니다.
- `channels.telegram.groups`: 그룹별 기본값 + 허용 목록 (글로벌 기본값에는 `"*"` 사용).
  - `channels.telegram.groups.<id>.groupPolicy`: groupPolicy 의 그룹별 재정의 (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: mention 게이팅 기본값.
  - `channels.telegram.groups.<id>.skills`: 스킬 필터 (생략 = 모든 스킬, 빈값 = 없음).
  - `channels.telegram.groups.<id>.allowFrom`: 그룹별 발신자 허용 목록 재정의.
  - `channels.telegram.groups.<id>.systemPrompt`: 그룹에 대한 추가 시스템 프롬프트.
  - `channels.telegram.groups.<id>.enabled`: `false` 일 때 그룹 비활성화.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: 토픽별 재정의 (그룹과 같은 필드).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: groupPolicy 의 토픽별 재정의 (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: 토픽별 mention 게이팅 재정의.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (기본: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: 계정별 재정의.
- `channels.telegram.commands.nativeSkills`: Telegram 네이티브 스킬 명령 활성화/비활성화.
- `channels.telegram.replyToMode`: `off | first | all` (기본: `off`).
- `channels.telegram.textChunkLimit`: 아웃바운드 청크 크기 (문자).
- `channels.telegram.chunkMode`: `length` (기본) 또는 `newline` - 길이 청킹 전 빈 줄 (단락 경계)에서 분할.
- `channels.telegram.linkPreview`: 아웃바운드 메시지의 링크 미리보기 토글 (기본: true).
- `channels.telegram.streaming`: `off | partial | block | progress` (라이브 스트림 미리보기. 기본: `off`. `progress` 는 `partial` 로 매핑. `block` 은 레거시 미리보기 모드 호환성).
- `channels.telegram.mediaMaxMb`: 인바운드 Telegram 미디어 다운로드/처리 제한 (MB).
- `channels.telegram.retry`: 복구 가능한 아웃바운드 API 오류에 대한 Telegram 전송 도우미 (CLI/도구/작업)의 재시도 정책 (시도, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: Node autoSelectFamily 재정의 (true=활성화, false=비활성화). Node 22+ 에서 기본 활성화, WSL2 는 기본 비활성화.
- `channels.telegram.network.dnsResultOrder`: DNS 결과 순서 재정의 (`ipv4first` 또는 `verbatim`). Node 22+ 에서 기본 `ipv4first`.
- `channels.telegram.proxy`: Bot API 호출에 대한 프록시 URL (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: webhook 모드 활성화 (requires `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: webhook secret (webhookUrl 설정 시 필수).
- `channels.telegram.webhookPath`: 로컬 webhook 경로 (기본 `/telegram-webhook`).
- `channels.telegram.webhookHost`: 로컬 webhook 바인드 호스트 (기본 `127.0.0.1`).
- `channels.telegram.webhookPort`: 로컬 webhook 바인드 포트 (기본 `8787`).
- `channels.telegram.actions.reactions`: Telegram 도구 반응 게이팅.
- `channels.telegram.actions.sendMessage`: Telegram 도구 메시지 전송 게이팅.
- `channels.telegram.actions.deleteMessage`: Telegram 도구 메시지 삭제 게이팅.
- `channels.telegram.actions.sticker`: Telegram 스티커 작업 게이팅 — 전송 및 검색 (기본: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — 어느 반응이 시스템 이벤트를 트리거하는지 제어 (기본: 설정되지 않을 때 `own`).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — 에이전트의 반응 기능 제어 (기본: 설정되지 않을 때 `minimal`).

- [구성 참조 - Telegram](/gateway/configuration-reference#telegram)

Telegram 특정 높은 신호 필드:

- 시작/인증: `enabled`, `botToken`, `tokenFile`, `accounts.*`
- 접근 제어: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`
- 명령/메뉴: `commands.native`, `commands.nativeSkills`, `customCommands`
- 스레딩/회신: `replyToMode`
- 스트리밍: `streaming` (미리보기), `blockStreaming`
- 서식/배달: `textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- 미디어/네트워크: `mediaMaxMb`, `timeoutSeconds`, `retry`, `network.autoSelectFamily`, `proxy`
- Webhook: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`
- 작업/기능: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- 반응: `reactionNotifications`, `reactionLevel`
- 쓰기/이력: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [다중 에이전트 라우팅](/concepts/multi-agent)
- [문제 해결](/channels/troubleshooting)
