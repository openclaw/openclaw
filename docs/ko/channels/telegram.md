---
read_when:
    - Telegram 기능 또는 웹훅 작업
summary: 텔레그램 봇 지원 상태, 기능 및 구성
title: 전보
x-i18n:
    generated_at: "2026-02-08T15:51:58Z"
    model: gtx
    provider: google-translate
    source_hash: 604e2dc12d2b776da5a02be6780583f1bf5299b12c6dd34549f116ae87dc9936
    source_path: channels/telegram.md
    workflow: 15
---

# 텔레그램(봇 API)

상태: grammY를 통해 봇 DM + 그룹에 대한 프로덕션 준비가 완료되었습니다. 기본적으로 긴 폴링; 웹훅은 선택사항입니다.

## 빠른 설정(초보자)

1. 다음을 사용하여 봇을 만듭니다. **@BotFather** ([직접 링크](https://t.me/BotFather)). 핸들이 정확히 맞는지 확인하세요. `@BotFather`을 클릭한 다음 토큰을 복사하세요.
2. 토큰을 설정합니다:
   - 환경: `TELEGRAM_BOT_TOKEN=...`
   - 또는 구성: `channels.telegram.botToken: "..."`.
   - 둘 다 설정된 경우 구성이 우선 적용됩니다(환경 대체는 기본 계정에만 해당).
3. 게이트웨이를 시작하십시오.
4. DM 액세스는 기본적으로 페어링됩니다. 첫 번째 연락 시 페어링 코드를 승인하세요.

최소 구성:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## 그것은 무엇입니까

- 게이트웨이가 소유한 Telegram Bot API 채널입니다.
- 결정적 라우팅: 답변이 텔레그램으로 돌아갑니다. 모델은 채널을 선택하지 않습니다.
- DM은 상담원의 기본 세션을 공유합니다. 그룹은 격리 상태를 유지합니다(`agent:<agentId>:telegram:group:<chatId>`).

## 설정(빠른 경로)

### 1) 봇 토큰(BotFather) 생성

1. 텔레그램을 열고 채팅하세요 **@BotFather** ([직접 링크](https://t.me/BotFather)). 핸들이 정확히 맞는지 확인하세요. `@BotFather`.
2. 달리다 `/newbot`을 누른 다음 프롬프트를 따릅니다(이름 + 다음으로 끝나는 사용자 이름). `bot`).
3. 토큰을 복사하여 안전하게 보관하세요.

선택적 BotFather 설정:

- `/setjoingroups` — 그룹에 봇 추가를 허용/거부합니다.
- `/setprivacy` — 봇이 모든 그룹 메시지를 볼 수 있는지 여부를 제어합니다.

### 2) 토큰 구성(env 또는 config)

예:

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

환경 옵션: `TELEGRAM_BOT_TOKEN=...` (기본 계정에서 작동)
env와 config가 모두 설정된 경우 config가 우선 적용됩니다.

다중 계정 지원: 사용 `channels.telegram.accounts` 계정별 토큰 및 선택 사항 포함 `name`. 보다 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 공유 패턴의 경우.

3. 게이트웨이를 시작하십시오. 토큰이 해결되면 텔레그램이 시작됩니다(구성 우선, 환경 폴백).
4. DM 액세스는 기본적으로 페어링으로 설정됩니다. 봇에 처음 접속할 때 코드를 승인하세요.
5. 그룹의 경우: 봇을 추가하고 개인 정보 보호/관리 동작을 결정한 다음(아래) 설정합니다. `channels.telegram.groups` 멘션 게이팅 + 허용 목록을 제어합니다.

## 토큰 + 개인 정보 보호 + 권한(텔레그램 측)

### 토큰 생성(BotFather)

- `/newbot` 봇을 생성하고 토큰을 반환합니다(비밀로 유지).
- 토큰이 유출되면 @BotFather를 통해 토큰을 취소/재생성하고 구성을 업데이트하세요.

### 그룹 메시지 공개(개인정보 보호 모드)

텔레그램 봇의 기본값은 다음과 같습니다. **개인 정보 보호 모드**, 이는 수신하는 그룹 메시지를 제한합니다.
봇이 보아야 하는 경우 _모두_ 그룹 메시지에는 두 가지 옵션이 있습니다.

- 다음을 사용하여 개인정보 보호 모드를 비활성화합니다. `/setprivacy` **또는**
- 봇을 그룹으로 추가 **관리자** (관리 봇은 모든 메시지를 수신합니다).

**메모:** 개인 정보 보호 모드를 전환하면 Telegram에서 봇을 제거하고 다시 추가해야 합니다.
변경 사항을 적용하려면 각 그룹에

### 그룹 권한(관리자 권한)

관리자 상태는 그룹(텔레그램 UI) 내부에서 설정됩니다. 관리 봇은 항상 모든 것을 받습니다.
메시지를 그룹화하므로 전체 가시성이 필요한 경우 관리자를 사용하세요.

## 작동 방식(행동)

- 인바운드 메시지는 응답 컨텍스트 및 미디어 자리 표시자가 있는 공유 채널 봉투로 정규화됩니다.
- 그룹 답글에는 기본적으로 멘션이 필요합니다(기본 @멘션 또는 `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- 다중 에이전트 재정의: 에이전트별 패턴 설정 `agents.list[].groupChat.mentionPatterns`.
- 답변은 항상 동일한 Telegram 채팅으로 다시 전달됩니다.
- 긴 폴링은 채팅별 순서를 지정하는 grammY 러너를 사용합니다. 전체 동시성은 다음으로 제한됩니다. `agents.defaults.maxConcurrent`.
- Telegram Bot API는 읽음 확인을 지원하지 않습니다. 없다 `sendReadReceipts` 옵션.

## 초안 스트리밍

OpenClaw는 다음을 사용하여 Telegram DM에서 부분 응답을 스트리밍할 수 있습니다. `sendMessageDraft`.

요구사항:

- @BotFather의 봇에 대해 스레드 모드가 활성화되었습니다(포럼 주제 모드).
- 비공개 채팅 스레드만(텔레그램에는 다음이 포함됩니다) `message_thread_id` 인바운드 메시지의 경우).
- `channels.telegram.streamMode` 으로 설정되지 않음 `"off"` (기본: `"partial"`, `"block"` 청크 초안 업데이트를 활성화합니다).

초안 스트리밍은 DM 전용입니다. 텔레그램은 그룹이나 채널에서는 지원하지 않습니다.

## 서식 지정(텔레그램 HTML)

- 아웃바운드 텔레그램 텍스트 사용 `parse_mode: "HTML"` (텔레그램이 지원하는 태그 하위 집합)
- Markdown-ish 입력은 다음으로 렌더링됩니다. **텔레그램 안전 HTML** (굵게/기울임꼴/스트라이크/코드/링크); 블록 요소는 개행/글머리 기호가 있는 텍스트로 병합됩니다.
- Telegram 구문 분석 오류를 방지하기 위해 모델의 원시 HTML이 이스케이프됩니다.
- Telegram이 HTML 페이로드를 거부하면 OpenClaw는 동일한 메시지를 일반 텍스트로 다시 시도합니다.

## 명령(네이티브 + 사용자 정의)

OpenClaw는 기본 명령(예: `/status`, `/reset`, `/model`) 시작 시 텔레그램의 봇 메뉴를 사용합니다.
구성을 통해 메뉴에 사용자 정의 명령을 추가할 수 있습니다.

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

## 설치 문제 해결(명령)

- `setMyCommands failed` 로그에서는 일반적으로 아웃바운드 HTTPS/DNS가 차단되었음을 의미합니다. `api.telegram.org`.
- 당신이 본다면 `sendMessage`또는`sendChatAction` 실패하면 IPv6 라우팅과 DNS를 확인하세요.

추가 도움말: [채널 문제 해결](/channels/troubleshooting).

참고:

- 사용자 정의 명령은 **메뉴 항목만**; OpenClaw는 다른 곳에서 처리하지 않는 한 이를 구현하지 않습니다.
- 명령 이름은 정규화되어 있습니다(선두 `/` 제거됨, 소문자) 및 일치해야 함 `a-z`, `0-9`, `_` (1~32자).
- 사용자 정의 명령 **기본 명령을 재정의할 수 없습니다.**. 충돌은 무시되고 기록됩니다.
- 만약에 `commands.native` 비활성화되면 사용자 정의 명령만 등록됩니다(또는 없는 경우 지워집니다).

## 제한

- 아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.telegram.textChunkLimit` (기본값은 4000).
- 선택적 개행 청킹: 설정 `channels.telegram.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- 미디어 다운로드/업로드는 다음으로 제한됩니다. `channels.telegram.mediaMaxMb` (기본값 5).
- Telegram Bot API 요청 시간 초과: `channels.telegram.timeoutSeconds` (grammY를 통해 기본값은 500) 긴 정지를 방지하려면 더 낮게 설정하십시오.
- 그룹 기록 컨텍스트 사용 `channels.telegram.historyLimit` (또는 `channels.telegram.accounts.*.historyLimit`), 다음으로 돌아감 `messages.groupChat.historyLimit`. 세트 `0` 비활성화합니다(기본값 50).
- DM 기록은 다음과 같이 제한될 수 있습니다. `channels.telegram.dmHistoryLimit` (사용자 회전). 사용자별 재정의: `channels.telegram.dms["<user_id>"].historyLimit`.

## 그룹 활성화 모드

기본적으로 봇은 그룹(`@botname` 또는 패턴 `agents.list[].groupChat.mentionPatterns`). 이 동작을 변경하려면:

### 구성을 통해(권장)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**중요한:** 환경 `channels.telegram.groups` 생성 **허용 목록** - 나열된 그룹만(또는 `"*"`)가 받아들여질 것입니다.
포럼 주제는 아래에 주제별 재정의를 추가하지 않는 한 상위 그룹 구성(allowFrom, requireMention, 기술, 프롬프트)을 상속합니다. `channels.telegram.groups.<groupId>.topics.<topicId>`.

항상 응답하는 모든 그룹을 허용하려면 다음 안내를 따르세요.

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

모든 그룹에 대해 멘션 전용을 유지하려면(기본 동작):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### 명령을 통해(세션 수준)

그룹에 보내기:

- `/activation always` - 모든 메시지에 응답
- `/activation mention` - 언급이 필요합니다 (기본값)

**메모:** 명령은 세션 상태만 업데이트합니다. 다시 시작해도 지속적인 동작을 수행하려면 config를 사용하세요.

### 그룹 채팅 ID 가져오기

그룹의 메시지를 다음으로 전달하세요. `@userinfobot`또는`@getidsbot` 텔레그램에서 채팅 ID(예: 음수)를 확인하려면 `-1001234567890`).

**팁:** 자신의 사용자 ID에 대해 DM을 보내면 봇이 사용자 ID(페어링 메시지)로 응답하거나 다음을 사용합니다. `/whoami` 명령이 활성화되면.

**개인정보 보호정책:** `@userinfobot` 타사 봇입니다. 원하는 경우 봇을 그룹에 추가하고 메시지를 보낸 다음 `openclaw logs --follow` 읽기 `chat.id`또는 Bot API를 사용하세요. `getUpdates`.

## 구성 쓰기

기본적으로 Telegram은 채널 이벤트에 의해 트리거되는 구성 업데이트를 작성하거나 `/config set|unset`.

이는 다음과 같은 경우에 발생합니다.

- 그룹이 슈퍼그룹으로 업그레이드되고 텔레그램이 `migrate_to_chat_id` (채팅 ID 변경). OpenClaw는 마이그레이션 가능 `channels.telegram.groups` 자동으로.
- 당신은 실행 `/config set`또는`/config unset` 텔레그램 채팅에서 (필수 `commands.config: true`).

다음을 사용하여 비활성화:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## 주제(포럼 슈퍼그룹)

텔레그램 포럼 주제에는 다음이 포함됩니다. `message_thread_id` 메시지당. 오픈클로:

- 추가 `:topic:<threadId>` Telegram 그룹 세션 키에 연결하여 각 주제를 격리합니다.
- 입력 표시기를 보내고 다음과 같이 응답합니다. `message_thread_id` 그래서 응답은 주제에 남아 있습니다.
- 일반 주제(스레드 ID `1`)는 특별합니다: 메시지 전송 생략 `message_thread_id` (텔레그램은 이를 거부합니다.) 그러나 입력 표시에는 여전히 포함되어 있습니다.
- 노출하다 `MessageThreadId` + `IsForum` 라우팅/템플릿을 위한 템플릿 컨텍스트에서.
- 주제별 구성은 다음에서 사용할 수 있습니다. `channels.telegram.groups.<chatId>.topics.<threadId>` (기술, 허용 목록, 자동 회신, 시스템 프롬프트, 비활성화).
- 주제 구성은 주제별로 재정의되지 않는 한 그룹 설정(requireMention, 허용 목록, 기술, 프롬프트, 활성화됨)을 상속합니다.

비공개 채팅에는 다음이 포함될 수 있습니다. `message_thread_id` 일부 극단적인 경우에는. OpenClaw는 DM 세션 키를 변경하지 않고 유지하지만, 존재하는 경우 응답/초안 스트리밍을 위해 스레드 ID를 계속 사용합니다.

## 인라인 버튼

텔레그램은 콜백 버튼이 있는 인라인 키보드를 지원합니다.

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

계정별 구성의 경우:

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

- `off` — 인라인 버튼이 비활성화되었습니다.
- `dm` — DM만(그룹 대상이 차단됨)
- `group` — 그룹만(DM 대상이 차단됨)
- `all` — DM + 그룹
- `allowlist` — DM + 그룹, 그러나 보낸 사람만 허용됩니다. `allowFrom` / `groupAllowFrom` (제어 명령과 동일한 규칙)

기본: `allowlist`.
유산: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### 보내기 버튼

메시지 도구를 다음과 함께 사용하세요. `buttons` 매개변수:

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

사용자가 버튼을 클릭하면 콜백 데이터가 다음 형식의 메시지로 에이전트에 다시 전송됩니다.
`callback_data: value`

### 구성 옵션

텔레그램 기능은 두 가지 수준으로 구성할 수 있습니다(위에 표시된 개체 형식, 레거시 문자열 배열은 계속 지원됨).

- `channels.telegram.capabilities`: 재정의되지 않는 한 모든 텔레그램 계정에 적용되는 전역 기본 기능 구성입니다.
- `channels.telegram.accounts.<account>.capabilities`: 특정 계정에 대한 전역 기본값을 재정의하는 계정별 기능입니다.

모든 텔레그램 봇/계정이 동일하게 작동해야 하는 경우 전역 설정을 사용하세요. 서로 다른 봇에 서로 다른 동작이 필요한 경우 계정별 구성을 사용합니다. 예를 들어 한 계정은 DM만 처리하고 다른 계정은 그룹에서 허용됩니다.

## 액세스 제어(DM + 그룹)

### DM접속

- 기본: `channels.telegram.dmPolicy = "pairing"`. 알 수 없는 발신자는 페어링 코드를 받습니다. 메시지는 승인될 때까지 무시됩니다(코드는 1시간 후에 만료됩니다).
- 승인 방법:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- 페어링은 텔레그램 DM에 사용되는 기본 토큰 교환입니다. 세부: [편성](/channels/pairing)
- `channels.telegram.allowFrom` 숫자로 된 사용자 ID를 허용합니다(권장). `@username` 항목. 그것은 **~ 아니다** 봇 사용자 이름; 인간 발신자의 ID를 사용합니다. 마법사가 수락합니다. `@username` 가능한 경우 숫자 ID로 확인합니다.

#### 텔레그램 사용자 ID 찾기

더 안전함(타사 봇 없음):

1. 게이트웨이를 시작하고 봇을 DM으로 보내세요.
2. 달리다 `openclaw logs --follow` 그리고 찾아보세요 `from.id`.

대체(공식 Bot API):

1. 봇에게 DM을 보내세요.
2. 봇 토큰으로 업데이트를 가져오고 읽습니다. `message.from.id`:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

제3자(비공개):

- DM `@userinfobot`또는`@getidsbot` 반환된 사용자 ID를 사용합니다.

### 그룹 액세스

두 개의 독립적인 컨트롤:

**1. 어떤 그룹이 허용되나요?** (그룹 허용 목록: `channels.telegram.groups`):

- 아니요 `groups` 구성 = 모든 그룹이 허용됨
- 와 함께 `groups` 구성 = 나열된 그룹만 또는 `"*"` 허용된다
- 예:`"groups": { "-1001234567890": {}, "*": {} }` 모든 그룹 허용

**2. 어떤 발신자가 허용되는지** (발신자 필터링을 통해 `channels.telegram.groupPolicy`):

- `"open"` = 허용된 그룹의 모든 발신자는 메시지를 보낼 수 있습니다.
- `"allowlist"` = 보낸 사람만 `channels.telegram.groupAllowFrom` 메시지를 보낼 수 있다
- `"disabled"` = 그룹 메시지가 전혀 허용되지 않습니다.
  기본값은 `groupPolicy: "allowlist"` (추가하지 않으면 차단됩니다. `groupAllowFrom`).

대부분의 사용자는 다음을 원합니다. `groupPolicy: "allowlist"` + `groupAllowFrom` + 다음에 나열된 특정 그룹 `channels.telegram.groups`

허용하려면 **모든 그룹 구성원** 특정 그룹에서 대화하려면(제어 명령을 승인된 발신자에게만 제한하면서) 그룹별 재정의를 설정하세요.

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

## 긴 폴링과 웹훅 비교

- 기본값: 긴 폴링(공개 URL이 필요하지 않음)
- 웹훅 모드: 설정 `channels.telegram.webhookUrl` 그리고 `channels.telegram.webhookSecret` (선택적으로 `channels.telegram.webhookPath`).
  - 로컬 리스너는 다음에 바인딩됩니다. `0.0.0.0:8787` 그리고 봉사하다 `POST /telegram-webhook` 기본적으로.
  - 공개 URL이 다른 경우 역방향 프록시를 사용하여 연결하세요. `channels.telegram.webhookUrl` 공개 끝점에서.

## 답글 스레딩

텔레그램은 태그를 통한 선택적 스레드 응답을 지원합니다:

- `[[reply_to_current]]` -- 트리거 메시지에 응답합니다.
- `[[reply_to:<id>]]` -- 특정 메시지 ID에 응답합니다.

다음에 의해 제어됨 `channels.telegram.replyToMode`:

- `first` (기본), `all`, `off`.

## 오디오 메시지(음성 대 파일)

텔레그램의 특징 **음성 메모** (둥근 거품)에서 **오디오 파일** (메타데이터 카드).
OpenClaw는 이전 버전과의 호환성을 위해 기본적으로 오디오 파일을 사용합니다.

상담원 답장에 음성 메모 풍선을 강제로 표시하려면 답장 어디에나 다음 태그를 포함하세요.

- `[[audio_as_voice]]` — 오디오를 파일 대신 음성 메모로 보냅니다.

태그는 전달된 텍스트에서 제거됩니다. 다른 채널에서는 이 태그를 무시합니다.

메시지 도구 전송의 경우 다음을 설정합니다. `asVoice: true` 음성 호환 오디오로 `media` URL
(`message` 미디어가 있는 경우 선택 사항입니다):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## 스티커

OpenClaw는 지능형 캐싱을 통해 Telegram 스티커 수신 및 전송을 지원합니다.

### 스티커 받기

사용자가 스티커를 보내면 OpenClaw는 스티커 유형에 따라 이를 처리합니다.

- **고정 스티커(WEBP):** 비전을 통해 다운로드 및 처리됩니다. 스티커가 다음과 같이 나타납니다. `<media:sticker>` 메시지 내용의 자리 표시자입니다.
- **애니메이션 스티커(TGS):** 건너뛰었습니다(Lottie 형식은 처리가 지원되지 않음).
- **비디오 스티커(WEBM):** 건너뛰었습니다(처리가 지원되지 않는 비디오 형식).

스티커 수신 시 사용할 수 있는 템플릿 컨텍스트 필드:

- `Sticker` — 객체:
  - `emoji` — 스티커와 관련된 이모티콘
  - `setName` — 스티커 세트 이름
  - `fileId` — 텔레그램 파일 ID (동일한 스티커를 다시 보냅니다)
  - `fileUniqueId` — 캐시 조회를 위한 안정적인 ID
  - `cachedDescription` — 가능한 경우 캐시된 비전 설명

### 스티커 캐시

스티커는 AI의 비전 기능을 통해 처리되어 설명을 생성합니다. 동일한 스티커가 반복적으로 전송되는 경우가 많기 때문에 OpenClaw는 중복된 API 호출을 피하기 위해 이러한 설명을 캐시합니다.

**작동 방식:**

1. **첫 만남:** 스티커 이미지는 시력 분석을 위해 AI로 전송됩니다. AI는 설명(예: "열정적으로 손을 흔드는 만화 고양이")을 생성합니다.
2. **캐시 저장:** 설명은 스티커의 파일 ID, 이모티콘, 세트 이름과 함께 저장됩니다.
3. **후속 만남:** 동일한 스티커가 다시 보일 때 캐시된 설명이 그대로 사용됩니다. 이미지는 AI로 전송되지 않습니다.

**캐시 위치:** `~/.openclaw/telegram/sticker-cache.json`

**캐시 항목 형식:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**이익:**

- 동일한 스티커에 대한 반복적인 비전 호출을 방지하여 API 비용을 절감합니다.
- 캐시된 스티커에 대한 더 빠른 응답 시간(비전 처리 지연 없음)
- 캐시된 설명을 기반으로 스티커 검색 기능을 활성화합니다.

캐시는 스티커를 받으면 자동으로 채워집니다. 수동 캐시 관리가 필요하지 않습니다.

### 스티커 보내기

상담원은 다음을 사용하여 스티커를 보내고 검색할 수 있습니다. `sticker` 그리고 `sticker-search` 행위. 이는 기본적으로 비활성화되어 있으며 구성에서 활성화해야 합니다.

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

**스티커 보내기:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

매개변수:

- `fileId` (필수) - 스티커의 텔레그램 파일 ID입니다. 이것을 얻으십시오 `Sticker.fileId` 스티커를 받았을 때나, `sticker-search` 결과.
- `replyTo` (선택 사항) — 회신할 메시지 ID입니다.
- `threadId` (선택 사항) — 포럼 주제에 대한 메시지 스레드 ID입니다.

**스티커 검색:**

상담원은 캐시된 스티커를 설명, 이모티콘 또는 세트 이름으로 검색할 수 있습니다.

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

캐시에서 일치하는 스티커를 반환합니다.

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

검색에서는 설명 텍스트, 이모티콘 문자 및 세트 이름에 대한 퍼지 일치를 사용합니다.

**스레딩의 예:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## 스트리밍(초안)

텔레그램은 스트리밍이 가능합니다 **초안 거품** 에이전트가 응답을 생성하는 동안.
OpenClaw는 Bot API를 사용합니다. `sendMessageDraft` (실제 메시지가 아님) 그런 다음
일반 메시지로 최종 응답합니다.

요구 사항(Telegram Bot API 9.3+):

- **주제가 활성화된 비공개 채팅** (봇의 포럼 주제 모드)
- 수신 메시지에는 다음이 포함되어야 합니다. `message_thread_id` (비공개 주제 스레드).
- 그룹/슈퍼그룹/채널에 대한 스트리밍은 무시됩니다.

구성:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (기본: `partial`)
  - `partial`: 최신 스트리밍 텍스트로 초안 풍선을 업데이트합니다.
  - `block`: 초안 풍선을 더 큰 블록(청크)으로 업데이트합니다.
  - `off`: 초안 스트리밍을 비활성화합니다.
- 선택사항(해당 `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - 기본값: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (고정 `channels.telegram.textChunkLimit`).

참고: 초안 스트리밍은 스트리밍과 별개입니다. **스트리밍 차단** (채널 메시지).
블록 스트리밍은 기본적으로 꺼져 있으며 다음이 필요합니다. `channels.telegram.blockStreaming: true`
초안 업데이트 대신 초기 텔레그램 메시지를 원하는 경우.

추론 스트림(텔레그램만 해당):

- `/reasoning stream` 답변이 작성되는 동안 추론을 초안 풍선으로 스트리밍합니다.
  생성한 다음 추론 없이 최종 답변을 보냅니다.
- 만약에 `channels.telegram.streamMode` ~이다 `off`, 추론 스트림이 비활성화되었습니다.
  추가 컨텍스트: [스트리밍 + 청킹](/concepts/streaming).

## 재시도 정책

아웃바운드 Telegram API 호출은 지수 백오프 및 지터가 있는 일시적인 네트워크/429 오류에 대해 재시도합니다. 다음을 통해 구성 `channels.telegram.retry`. 보다 [재시도 정책](/concepts/retry).

## 에이전트 도구(메시지 + 반응)

- 도구: `telegram` ~와 함께 `sendMessage` 행동 (`to`, `content`, 선택사항 `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- 도구: `telegram` ~와 함께 `react` 행동 (`chatId`, `messageId`, `emoji`).
- 도구: `telegram` ~와 함께 `deleteMessage` 행동 (`chatId`, `messageId`).
- 반응 제거 의미: 참조 [/도구/반응](/tools/reactions).
- 도구 게이팅: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (기본값: 활성화됨) 및 `channels.telegram.actions.sticker` (기본값: 비활성화됨).

## 반응 알림

**반응 작동 방식:**
전보 반응은 다음과 같이 도착합니다. **분리된 `message_reaction` 이벤트**, 메시지 페이로드의 속성이 아닙니다. 사용자가 반응을 추가하면 OpenClaw는 다음을 수행합니다.

1. 수신 `message_reaction` 텔레그램 API에서 업데이트
2. 로 변환합니다. **시스템 이벤트** 형식: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. 다음을 사용하여 시스템 이벤트를 대기열에 넣습니다. **동일한 세션 키** 일반 메시지로
4. 해당 대화에 다음 메시지가 도착하면 시스템 이벤트가 배출되어 에이전트의 컨텍스트 앞에 추가됩니다.

에이전트는 반응을 다음과 같이 봅니다. **시스템 알림** 메시지 메타데이터가 아닌 대화 기록에 포함됩니다.

**구성:**

- `channels.telegram.reactionNotifications`: 알림을 트리거하는 반응을 제어합니다.
  - `"off"` — 모든 반응을 무시
  - `"own"` — 사용자가 봇 메시지에 반응할 때 알림(최선의 노력, 메모리 내)(기본값)
  - `"all"` — 모든 반응에 대해 알림

- `channels.telegram.reactionLevel`: 제제의 반응능력을 조절합니다.
  - `"off"` — 에이전트가 메시지에 반응할 수 없습니다.
  - `"ack"` — 봇이 승인 반응을 보냅니다(문제 처리 중)(기본값)
  - `"minimal"` — 상담원이 드물게 반응할 수 있습니다(가이드라인: 5~10회 교환당 1회).
  - `"extensive"` — 에이전트는 적절할 때 자유롭게 반응할 수 있습니다.

**포럼 그룹:** 포럼 그룹의 반응에는 다음이 포함됩니다. `message_thread_id` 다음과 같은 세션 키를 사용하십시오. `agent:main:telegram:group:{chatId}:topic:{threadId}`. 이렇게 하면 동일한 주제의 반응과 메시지가 함께 유지됩니다.

**예시 구성:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**요구사항:**

- 텔레그램 봇은 명시적으로 요청해야 합니다. `message_reaction` ~에 `allowed_updates` (OpenClaw에 의해 자동으로 구성됨)
- 웹훅 모드의 경우 반응이 웹훅에 포함됩니다. `allowed_updates`
- 폴링 모드의 경우 반응이 `getUpdates` `allowed_updates`

## 전달 대상(CLI/cron)

- 채팅 ID(`123456789`) 또는 사용자 이름(`@name`)를 대상으로 합니다.
- 예:`openclaw message send --channel telegram --target 123456789 --message "hi"`.

## 문제 해결

**봇은 그룹에서 언급되지 않은 메시지에 응답하지 않습니다.**

- 설정하면 `channels.telegram.groups.*.requireMention=false`, 텔레그램의 봇 API **개인 정보 보호 모드** 비활성화되어야 합니다.
  - 봇아버지: `/setprivacy` → **장애를 입히다** (그런 다음 그룹에 봇을 제거하고 다시 추가)
- `openclaw channels status` 구성에서 언급되지 않은 그룹 메시지가 예상되면 경고를 표시합니다.
- `openclaw channels status --probe` 명시적인 숫자 그룹 ID에 대한 멤버십을 추가로 확인할 수 있습니다(와일드카드는 감사할 수 없습니다). `"*"` 규칙).
- 빠른 테스트: `/activation always` (세션 전용, 지속성을 위해 구성 사용)

**봇이 그룹 메시지를 전혀 보지 못합니다:**

- 만약에 `channels.telegram.groups` 설정되면 그룹을 나열하거나 사용해야 합니다. `"*"`
- @BotFather의 개인정보 설정을 확인하세요. → "그룹 개인정보 보호"가 있어야 합니다. **끄다**
- 봇이 실제로 구성원인지 확인하세요(읽기 액세스 권한이 없는 관리자뿐만 아니라).
- 게이트웨이 로그를 확인하세요. `openclaw logs --follow` ("그룹 메시지 건너뛰기"를 찾으세요)

**봇은 멘션에 응답하지만 응답하지 않습니다. `/activation always`:**

- 그만큼 `/activation` 명령은 세션 상태를 업데이트하지만 구성을 유지하지 않습니다.
- 지속적인 동작을 위해서는 다음에 그룹을 추가하세요. `channels.telegram.groups` ~와 함께 `requireMention: false`

**다음과 같은 명령 `/status` 작동하지 않습니다:**

- 텔레그램 사용자 ID가 인증되었는지 확인하세요(페어링 또는 `channels.telegram.allowFrom`)
- 명령은 다음과 같은 그룹에서도 인증이 필요합니다. `groupPolicy: "open"`

**노드 22+에서는 장기 폴링이 즉시 중단됩니다(종종 프록시/사용자 지정 가져오기 사용).**

- 노드 22+는 다음 사항에 대해 더 엄격합니다. `AbortSignal` 인스턴스; 외부 신호가 중단될 수 있음 `fetch` 바로 전화해.
- 중단 신호를 정규화하는 OpenClaw 빌드로 업그레이드하거나 업그레이드할 수 있을 때까지 노드 20에서 게이트웨이를 실행하세요.

**봇이 시작된 후 자동으로 응답을 중지하거나 로그를 기록합니다. `HttpError: Network request ... failed`):**

- 일부 호스트는 해결합니다. `api.telegram.org` 먼저 IPv6로. 서버에 IPv6 송신이 작동하지 않는 경우 grammY는 IPv6 전용 요청에 멈출 수 있습니다.
- IPv6 송신을 활성화하여 문제 해결 **또는** IPv4 확인을 강제로 수행 `api.telegram.org` (예를 들어 `/etc/hosts` IPv4 A 레코드를 사용하여 항목을 입력하거나 OS DNS 스택에서 IPv4를 선호하는 경우) 게이트웨이를 다시 시작하세요.
- 빠른 확인: `dig +short api.telegram.org A` 그리고 `dig +short api.telegram.org AAAA` DNS가 반환하는 내용을 확인합니다.

## 구성 참조(텔레그램)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.telegram.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.telegram.botToken`: 봇 토큰(BotFather).
- `channels.telegram.tokenFile`: 파일 경로에서 토큰을 읽습니다.
- `channels.telegram.dmPolicy`:`pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.telegram.allowFrom`: DM 허용 목록(ID/사용자 이름). `open` 필요하다 `"*"`.
- `channels.telegram.groupPolicy`:`open | allowlist | disabled` (기본값: 허용 목록).
- `channels.telegram.groupAllowFrom`: 그룹 발신자 허용 목록(ID/사용자 이름).
- `channels.telegram.groups`: 그룹별 기본값 + 허용 목록(사용 `"*"` 전역 기본값의 경우).
  - `channels.telegram.groups.<id>.groupPolicy`: groupPolicy에 대한 그룹별 재정의(`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: 게이팅 기본값을 언급합니다.
  - `channels.telegram.groups.<id>.skills`: 스킬 필터(생략 = 모든 스킬, 비어 있음 = 없음).
  - `channels.telegram.groups.<id>.allowFrom`: 그룹별 발신자 허용 목록 재정의.
  - `channels.telegram.groups.<id>.systemPrompt`: 그룹에 대한 추가 시스템 프롬프트입니다.
  - `channels.telegram.groups.<id>.enabled`: 다음과 같은 경우 그룹을 비활성화합니다. `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: 주제별 재정의(그룹과 동일한 필드)
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: groupPolicy에 대한 주제별 재정의(`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: 주제별 언급 게이팅 재정의.
- `channels.telegram.capabilities.inlineButtons`:`off | dm | group | all | allowlist` (기본값: 허용 목록).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: 계정별 재정의.
- `channels.telegram.replyToMode`:`off | first | all` (기본: `first`).
- `channels.telegram.textChunkLimit`: 아웃바운드 청크 크기(문자)입니다.
- `channels.telegram.chunkMode`:`length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- `channels.telegram.linkPreview`: 아웃바운드 메시지에 대한 링크 미리보기를 전환합니다(기본값: true).
- `channels.telegram.streamMode`:`off | partial | block` (초안 스트리밍).
- `channels.telegram.mediaMaxMb`: 인바운드/아웃바운드 미디어 캡(MB)입니다.
- `channels.telegram.retry`: 아웃바운드 Telegram API 호출(시도, minDelayMs, maxDelayMs, jitter)에 대한 재시도 정책입니다.
- `channels.telegram.network.autoSelectFamily`: 노드 autoSelectFamily를 재정의합니다(true=활성화, false=비활성화). Happy Eyeballs 시간 초과를 방지하기 위해 노드 22에서는 기본값이 비활성화되어 있습니다.
- `channels.telegram.proxy`: Bot API 호출(SOCKS/HTTP)을 위한 프록시 URL입니다.
- `channels.telegram.webhookUrl`: 웹훅 모드를 활성화합니다(필수 `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: 웹훅 비밀(webhookUrl이 설정된 경우 필요)
- `channels.telegram.webhookPath`: 로컬 웹훅 경로(기본값) `/telegram-webhook`).
- `channels.telegram.actions.reactions`: 게이트 전보 도구 반응.
- `channels.telegram.actions.sendMessage`: 게이트 텔레그램 도구 메시지가 전송됩니다.
- `channels.telegram.actions.deleteMessage`: 게이트 텔레그램 도구 메시지가 삭제됩니다.
- `channels.telegram.actions.sticker`: 게이트 텔레그램 스티커 작업 — 전송 및 검색(기본값: false).
- `channels.telegram.reactionNotifications`:`off | own | all` — 시스템 이벤트를 트리거하는 반응을 제어합니다(기본값: `own` 설정되지 않은 경우).
- `channels.telegram.reactionLevel`:`off | ack | minimal | extensive` — 제어 에이전트의 반응 능력(기본값: `minimal` 설정되지 않은 경우).

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (게이팅 패턴 언급)
- `messages.groupChat.mentionPatterns` (전역 대체).
- `commands.native` (기본값은 `"auto"` → 텔레그램/디스코드는 켜짐, Slack은 꺼짐), `commands.text`, `commands.useAccessGroups` (명령 동작). 다음으로 재정의 `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
