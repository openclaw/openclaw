---
read_when: Setting up Slack or debugging Slack socket/HTTP mode
summary: 소켓 또는 HTTP 웹훅 모드에 대한 Slack 설정
title: 느슨하게
x-i18n:
    generated_at: "2026-02-08T15:49:36Z"
    model: gtx
    provider: google-translate
    source_hash: 8ab00a8a93ec31b7d70d1fa37d9f99ed49043ba244ac10031dda88aacd97244e
    source_path: channels/slack.md
    workflow: 15
---

# 느슨하게

## 소켓 모드(기본값)

### 빠른 설정(초보자)

1. Slack 앱 생성 및 활성화 **소켓 모드**.
2. 만들기 **앱 토큰** (`xapp-...`) 그리고 **봇 토큰** (`xoxb-...`).
3. OpenClaw용 토큰을 설정하고 게이트웨이를 시작합니다.

최소 구성:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### 설정

1. Slack 앱 만들기(처음부터) [https://api.slack.com/apps](https://api.slack.com/apps).
2. **소켓 모드** → 켜십시오. 그런 다음 **기본정보** → **앱 수준 토큰** → **토큰 및 범위 생성** 범위가 있는 `connections:write`. 복사 **앱 토큰** (`xapp-...`).
3. **OAuth 및 권한** → 봇 토큰 범위를 추가합니다(아래 매니페스트 사용). 딸깍 하는 소리 **작업공간에 설치**. 복사 **봇 사용자 OAuth 토큰** (`xoxb-...`).
4. 선택 과목: **OAuth 및 권한** → 추가 **사용자 토큰 범위** (아래 읽기 전용 목록 참조) 앱을 다시 설치하고 복사하세요. **사용자 OAuth 토큰** (`xoxp-...`).
5. **이벤트 구독** → 이벤트 활성화 및 구독:
   - `message.*` (수정/삭제/스레드 방송 포함)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. 읽고 싶은 채널에 봇을 초대하세요.
7. 슬래시 명령 → 생성 `/openclaw` 당신이 사용하는 경우 `channels.slack.slashCommand`. 기본 명령을 활성화하는 경우 기본 제공 명령당 하나의 슬래시 명령을 추가합니다( `/help`). 설정하지 않는 한 Slack의 기본 기본값은 꺼짐입니다. `channels.slack.commands.native: true` (글로벌 `commands.native` ~이다 `"auto"` 그러면 Slack이 꺼집니다.)
8. 앱 홈 → 활성화 **메시지 탭** 사용자가 봇에게 DM을 보낼 수 있습니다.

범위와 이벤트가 동기화 상태를 유지하도록 아래 매니페스트를 사용하세요.

다중 계정 지원: 사용 `channels.slack.accounts` 계정별 토큰 및 선택 사항 포함 `name`. 보다 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 공유 패턴의 경우.

### OpenClaw 구성(소켓 모드)

환경 변수를 통해 토큰 설정(권장):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

또는 구성을 통해:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### 사용자 토큰(선택사항)

OpenClaw는 Slack 사용자 토큰(`xoxp-...`) 읽기 작업(기록,
핀, 반응, 이모티콘, 회원 정보). 기본적으로 읽기 전용으로 유지됩니다.
존재하는 경우 사용자 토큰을 선호하고 쓰기는 계속해서 봇 토큰을 사용합니다.
귀하는 명시적으로 동의합니다. `userTokenReadOnly: false`, 봇 토큰은 유지됩니다
가능한 경우 쓰기에 선호됩니다.

사용자 토큰은 구성 파일에서 구성됩니다(env var 지원 없음). 에 대한
다중 계정, 설정 `channels.slack.accounts.<id>.userToken`.

봇 + 앱 + 사용자 토큰의 예:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

userTokenReadOnly가 명시적으로 설정된 예(사용자 토큰 쓰기 허용):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### 토큰 사용

- 읽기 작업(기록, 반응 목록, 핀 목록, 이모티콘 목록, 회원 정보,
  검색) 구성된 경우 사용자 토큰을 선호하고, 그렇지 않으면 봇 토큰을 선호합니다.
- 쓰기 작업(메시지 보내기/편집/삭제, 반응 추가/제거, 고정/고정 해제,
  파일 업로드) 기본적으로 봇 토큰을 사용합니다. 만약에 `userTokenReadOnly: false` 그리고
  사용 가능한 봇 토큰이 없으면 OpenClaw는 사용자 토큰으로 대체됩니다.

### 역사 맥락

- `channels.slack.historyLimit` (또는 `channels.slack.accounts.*.historyLimit`) 프롬프트에 래핑되는 최근 채널/그룹 메시지 수를 제어합니다.
- 다음으로 돌아갑니다. `messages.groupChat.historyLimit`. 세트 `0` 비활성화합니다(기본값 50).

## HTTP 모드(이벤트 API)

HTTPS를 통해 Slack에서 게이트웨이에 연결할 수 있는 경우 HTTP 웹후크 모드를 사용합니다(서버 배포의 경우 일반적).
HTTP 모드는 공유 요청 URL과 함께 이벤트 API + 상호작용 + 슬래시 명령을 사용합니다.

### 설정(HTTP 모드)

1. Slack 앱을 만들고 **소켓 모드 비활성화** (HTTP만 사용하는 경우 선택 사항).
2. **기본정보** → 복사하다 **서명 비밀**.
3. **OAuth 및 권한** → 앱을 설치하고 복사하세요. **봇 사용자 OAuth 토큰** (`xoxb-...`).
4. **이벤트 구독** → 이벤트를 활성화하고 설정 **요청 URL** 게이트웨이 웹훅 경로(기본값) `/slack/events`).
5. **상호작용 및 바로가기** → 활성화하고 동일하게 설정 **요청 URL**.
6. **슬래시 명령** → 동일하게 설정 **요청 URL** 귀하의 명령에 대해.

요청 URL 예시:
`https://gateway-host/slack/events`

### OpenClaw 구성(최소)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

다중 계정 HTTP 모드: 설정 `channels.slack.accounts.<id>.mode = "http"` 그리고 독특한 것을 제공합니다
`webhookPath` 계정별로 각 Slack 앱이 자체 URL을 가리킬 수 있도록 합니다.

### 매니페스트(선택사항)

이 Slack 앱 매니페스트를 사용하여 앱을 빠르게 생성하세요(원하는 경우 이름/명령 조정). 포함
사용자 토큰을 구성하려는 경우 사용자 범위.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

기본 명령을 활성화하는 경우 하나를 추가하십시오. `slash_commands` 노출하려는 명령당 항목( `/help` 목록). 다음으로 재정의 `channels.slack.commands.native`.

## 범위(현재 및 선택 사항)

Slack의 Conversations API는 유형 범위가 지정되어 있습니다.
실제로 터치하는 대화 유형(채널, 그룹, 메신저, mpim). 보다
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) 개요를 위해.

### 봇 토큰 범위(필수)

- `chat:write` (다음을 통해 메시지 보내기/업데이트/삭제) `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (다음을 통해 DM을 엽니다. `conversations.open` 사용자 DM의 경우)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (사용자 조회)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (다음을 통해 업로드 `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### 사용자 토큰 범위(선택 사항, 기본적으로 읽기 전용)

아래에 추가하세요 **사용자 토큰 범위** 구성하면 `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### 현재는 필요하지 않지만 미래에는 필요하지 않음

- `mpim:write` (그룹 DM 열기/DM 시작을 추가하는 경우에만 해당) `conversations.open`)
- `groups:write` (비공개 채널 관리를 추가하는 경우에만: 생성/이름 바꾸기/초대/보관)
- `chat:write.public` (봇이 없는 채널에 게시하려는 경우에만)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (다음의 이메일 필드가 필요한 경우에만 `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (파일 메타데이터 나열/읽기를 시작하는 경우에만)

## 구성

Slack은 소켓 모드만 사용합니다(HTTP 웹훅 서버 없음). 두 토큰을 모두 제공합니다.

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

토큰은 env 변수를 통해 제공될 수도 있습니다.

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack 반응은 다음을 통해 전역적으로 제어됩니다. `messages.ackReaction` +
`messages.ackReactionScope`. 사용 `messages.removeAckAfterReply` 지우기 위해
봇이 응답한 후 ack 반응입니다.

## 제한

- 아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.slack.textChunkLimit` (기본값은 4000).
- 선택적 개행 청킹: 설정 `channels.slack.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- 미디어 업로드는 다음으로 제한됩니다. `channels.slack.mediaMaxMb` (기본값 20).

## 답글 스레딩

기본적으로 OpenClaw는 기본 채널에서 응답합니다. 사용 `channels.slack.replyToMode` 자동 스레딩을 제어하려면:

| Mode    | Behavior                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Default.** Reply in main channel. Only thread if the triggering message was already in a thread.                                                                  |
| `first` | First reply goes to thread (under the triggering message), subsequent replies go to main channel. Useful for keeping context visible while avoiding thread clutter. |
| `all`   | All replies go to thread. Keeps conversations contained but may reduce visibility.                                                                                  |

이 모드는 자동 응답 및 에이전트 도구 통화 모두에 적용됩니다(`slack sendMessage`).

### 채팅별 스레딩

설정을 통해 채팅 유형별로 다른 스레딩 동작을 구성할 수 있습니다. `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

지원되는 채팅 유형:

- `direct`: 1:1 DM(Slack `im`)
- `group`: 그룹 DM/MPIM(Slack `mpim`)
- `channel`: 표준 채널(공개/비공개)

상위:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. 공급자 기본값(`off`)

유산 `channels.slack.dm.replyToMode` 여전히 대체 수단으로 받아들여지고 있습니다. `direct` 채팅 유형 재정의가 설정되지 않은 경우.

예:

스레드 DM만 해당:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

스레드 그룹 DM은 루트에 채널을 유지합니다.

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

채널 스레드를 만들고 DM을 루트에 유지합니다.

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### 수동 스레딩 태그

세밀하게 제어하려면 상담원 응답에 다음 태그를 사용하세요.

- `[[reply_to_current]]` — 트리거 메시지에 응답합니다(스레드 시작/계속).
- `[[reply_to:<id>]]` — 특정 메시지 ID에 응답합니다.

## 세션 + 라우팅

- DM은 다음을 공유합니다. `main` 세션(예: WhatsApp/Telegram).
- 채널은 다음에 매핑됩니다. `agent:<agentId>:slack:channel:<channelId>` 세션.
- 슬래시 명령 사용 `agent:<agentId>:slack:slash:<userId>` 세션(다음을 통해 구성 가능한 접두사 `channels.slack.slashCommand.sessionPrefix`).
- Slack이 제공하지 않는 경우 `channel_type`, OpenClaw는 채널 ID 접두사(`D`, `C`, `G`) 및 기본값은 `channel` 세션 키를 안정적으로 유지합니다.
- 기본 명령 등록 사용 `commands.native` (전역 기본값 `"auto"` → 느슨해짐) 다음을 사용하여 작업공간별로 재정의할 수 있습니다. `channels.slack.commands.native`. 텍스트 명령에는 독립 실행형이 필요합니다. `/...` 메시지를 사용하여 비활성화할 수 있습니다. `commands.text: false`. Slack 슬래시 명령은 Slack 앱에서 관리되며 자동으로 제거되지 않습니다. 사용 `commands.useAccessGroups: false` 명령에 대한 액세스 그룹 검사를 우회합니다.
- 전체 명령 목록 + 구성: [슬래시 명령](/tools/slash-commands)

## DM 보안(페어링)

- 기본: `channels.slack.dm.policy="pairing"` — 알 수 없는 DM 발신자는 페어링 코드를 받습니다(1시간 후 만료).
- 승인 방법: `openclaw pairing approve slack <code>`.
- 누구든지 허용하려면: 설정 `channels.slack.dm.policy="open"` 그리고 `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` 사용자 ID, @handles 또는 이메일을 허용합니다(토큰이 허용되면 시작 시 해결됨). 마법사는 사용자 이름을 수락하고 토큰이 허용되면 설정 중에 이를 ID로 확인합니다.

## 그룹 정책

- `channels.slack.groupPolicy` 채널 처리를 제어합니다(`open|disabled|allowlist`).
- `allowlist` 채널이 다음에 나열되어야 합니다. `channels.slack.channels`.
- 설정만 하면 `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` 절대 만들지 마세요. `channels.slack` 섹션,
  런타임 기본값 `groupPolicy` 에게 `open`. 추가하다 `channels.slack.groupPolicy`, 
  `channels.defaults.groupPolicy`또는 채널 허용 목록을 사용하여 잠글 수 있습니다.
- 구성 마법사가 수락합니다. `#channel` 가능한 경우 이름을 지정하고 이를 ID로 확인합니다.
  (공개 + 비공개); 일치하는 항목이 여러 개 있으면 활성 채널을 선호합니다.
- 시작 시 OpenClaw는 허용 목록의 채널/사용자 이름을 ID로 확인합니다(토큰이 허용되는 경우).
  매핑을 기록합니다. 해결되지 않은 항목은 입력한 대로 유지됩니다.
- 허용하려면 **채널 없음**, 세트 `channels.slack.groupPolicy: "disabled"` (또는 빈 허용 목록을 유지하세요)

채널 옵션(`channels.slack.channels.<id>` 또는 `channels.slack.channels.<name>`):

- `allow`: 다음과 같은 경우 채널을 허용/거부합니다. `groupPolicy="allowlist"`.
- `requireMention`: 채널에 대한 게이팅을 언급합니다.
- `tools`: 선택적인 채널별 도구 정책 재정의(`allow` / `deny` / `alsoAllow`).
- `toolsBySender`: 채널 내 선택적인 발신자별 도구 정책 재정의(키는 발신자 ID/@handles/emails입니다. `"*"` 와일드카드 지원).
- `allowBots`: 이 채널에서 봇이 작성한 메시지를 허용합니다(기본값: false).
- `users`: 선택적인 채널별 사용자 허용 목록입니다.
- `skills`: 스킬 필터(생략 = 모든 스킬, 비어 있음 = 없음).
- `systemPrompt`: 채널에 대한 추가 시스템 프롬프트(주제/목적과 결합)
- `enabled`: 세트 `false` 채널을 비활성화합니다.

## 배송대상

cron/CLI 전송과 함께 다음을 사용하세요.

- `user:<id>` DM용
- `channel:<id>` 채널용

## 도구 작업

Slack 도구 작업은 다음을 통해 제어할 수 있습니다. `channels.slack.actions.*`:

| Action group | Default | Notes                  |
| ------------ | ------- | ---------------------- |
| reactions    | enabled | React + list reactions |
| messages     | enabled | Read/send/edit/delete  |
| pins         | enabled | Pin/unpin/list         |
| memberInfo   | enabled | Member info            |
| emojiList    | enabled | Custom emoji list      |

## 보안 참고 사항

- 상태 변경 작업의 범위가 봇 토큰으로 유지되도록 봇 토큰에 기본값을 씁니다.
  앱의 봇 권한 및 ID.
- 환경 `userTokenReadOnly: false` 사용자 토큰을 쓰기에 사용할 수 있습니다.
  봇 토큰을 사용할 수 없을 때의 작업, 즉 작업이 봇 토큰으로 실행됨을 의미합니다.
  사용자 액세스를 설치합니다. 사용자 토큰을 높은 권한으로 취급하고 유지합니다.
  작업 게이트와 허용 목록이 엄격합니다.
- 사용자 토큰 쓰기를 활성화하는 경우 사용자 토큰에 쓰기가 포함되어 있는지 확인하세요.
  예상하는 범위(`chat:write`, `reactions:write`, `pins:write`, 
  `files:write`) 그렇지 않으면 해당 작업이 실패합니다.

## 문제 해결

먼저 이 사다리를 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 필요한 경우 DM 페어링 상태를 확인합니다.

```bash
openclaw pairing list slack
```

일반적인 오류:

- 연결되었지만 채널 응답이 없습니다. 채널이 차단되었습니다. `groupPolicy` 아니면 안에 있지 않은지 `channels.slack.channels` 허용 목록.
- DM 무시됨: 발신자가 승인되지 않은 경우 `channels.slack.dm.policy="pairing"`.
- API 오류(`missing_scope`, `not_in_channel`, 인증 실패): 봇/앱 토큰 또는 Slack 범위가 불완전합니다.

분류 흐름의 경우: [/채널/문제해결](/channels/troubleshooting).

## 메모

- 멘션 게이팅은 다음을 통해 제어됩니다. `channels.slack.channels` (세트 `requireMention` 에게 `true`); `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`)도 언급된 것으로 간주됩니다.
- 다중 에이전트 재정의: 에이전트별 패턴 설정 `agents.list[].groupChat.mentionPatterns`.
- 반응 알림이 따라옵니다. `channels.slack.reactionNotifications` (사용 `reactionAllowlist` 모드 포함 `allowlist`).
- 봇이 작성한 메시지는 기본적으로 무시됩니다. 다음을 통해 활성화 `channels.slack.allowBots` 또는 `channels.slack.channels.<id>.allowBots`.
- 경고: 다른 봇에 대한 답장을 허용하는 경우(`channels.slack.allowBots=true` 또는 `channels.slack.channels.<id>.allowBots=true`), 다음을 사용하여 봇 간 응답 루프를 방지합니다. `requireMention`, `channels.slack.channels.<id>.users` 허용 목록 및/또는 명확한 가드레일 `AGENTS.md` 그리고 `SOUL.md`.
- Slack 도구의 경우 반응 제거 의미 체계는 다음과 같습니다. [/도구/반응](/tools/reactions).
- 첨부 파일은 허용되고 크기 제한 미만인 경우 미디어 저장소에 다운로드됩니다.
