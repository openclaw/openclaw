---
summary: "Socket 또는 HTTP 웹훅 모드를 위한 Slack 설정"
read_when: "Slack 설정 또는 Slack socket/HTTP 모드 디버깅 시"
title: "Slack"
---

# Slack

## Socket 모드 (기본값)

### 빠른 설정 (초보자)

1. Slack 앱을 생성하고 **Socket Mode** 를 활성화합니다.
2. **App Token** (`xapp-...`) 과 **Bot Token** (`xoxb-...`) 을 생성합니다.
3. OpenClaw 에 토큰을 설정하고 Gateway(게이트웨이) 를 시작합니다.

최소 설정:

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

1. [https://api.slack.com/apps](https://api.slack.com/apps) 에서 Slack 앱을 생성합니다 (From scratch).
2. **Socket Mode** → 켬으로 전환합니다. 그런 다음 **Basic Information** → **App-Level Tokens** → 범위 `connections:write` 로 **Generate Token and Scopes** 를 선택합니다. **App Token** (`xapp-...`) 을 복사합니다.
3. **OAuth & Permissions** → 봇 토큰 범위를 추가합니다 (아래 매니페스트 사용). **Install to Workspace** 를 클릭합니다. **Bot User OAuth Token** (`xoxb-...`) 을 복사합니다.
4. 선택 사항: **OAuth & Permissions** → **User Token Scopes** 를 추가합니다 (아래 읽기 전용 목록 참조). 앱을 다시 설치하고 **User OAuth Token** (`xoxp-...`) 을 복사합니다.
5. **Event Subscriptions** → 이벤트를 활성화하고 다음을 구독합니다:
   - `message.*` (편집/삭제/스레드 브로드캐스트 포함)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. 읽도록 할 채널에 봇을 초대합니다.
7. Slash Commands → `channels.slack.slashCommand` 를 사용하는 경우 `/openclaw` 를 생성합니다. 네이티브 명령을 활성화하는 경우, 내장 명령마다 하나의 슬래시 명령을 추가합니다 (`/help` 와 동일한 이름). Slack 에서는 기본적으로 네이티브가 꺼져 있으므로 `channels.slack.commands.native: true` 를 설정해야 합니다 (전역 `commands.native` 의 기본값은 `"auto"` 로 Slack 을 끕니다).
8. App Home → **Messages Tab** 을 활성화하여 사용자가 봇에게 다이렉트 메시지 를 보낼 수 있게 합니다.

아래 매니페스트를 사용하면 범위와 이벤트를 동기화된 상태로 유지할 수 있습니다.

다중 계정 지원: 계정별 토큰과 선택적 `name` 를 사용하여 `channels.slack.accounts` 를 설정합니다. 공통 패턴은 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 를 참조하십시오.

### OpenClaw 설정 (Socket 모드)

환경 변수로 토큰을 설정하세요 (권장):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

또는 설정 파일로 지정합니다:

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

### 사용자 토큰 (선택 사항)

OpenClaw 는 읽기 작업 (히스토리, 핀, 반응, 이모지, 멤버 정보) 에 Slack 사용자 토큰 (`xoxp-...`) 을 사용할 수 있습니다. 기본적으로 읽기 전용으로 유지됩니다. 사용자 토큰이 있으면 읽기는 사용자 토큰을 우선하며, 쓰기는 명시적으로 옵트인하지 않는 한 봇 토큰을 사용합니다. `userTokenReadOnly: false` 를 설정하더라도, 봇 토큰이 사용 가능하면 쓰기에는 봇 토큰이 계속 우선됩니다.

사용자 토큰은 설정 파일에서만 구성할 수 있습니다 (환경 변수 미지원). 다중 계정의 경우 `channels.slack.accounts.<id>.userToken` 를 설정하십시오.

봇 + 앱 + 사용자 토큰 예시:

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

userTokenReadOnly 를 명시적으로 설정한 예시 (사용자 토큰 쓰기 허용):

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

#### 토큰 사용 규칙

- 읽기 작업 (히스토리, 반응 목록, 핀 목록, 이모지 목록, 멤버 정보, 검색) 은 구성된 경우 사용자 토큰을 우선 사용하며, 그렇지 않으면 봇 토큰을 사용합니다.
- 쓰기 작업 (메시지 전송/편집/삭제, 반응 추가/제거, 핀/해제, 파일 업로드) 은 기본적으로 봇 토큰을 사용합니다. `userTokenReadOnly: false` 이고 봇 토큰이 없을 경우 OpenClaw 는 사용자 토큰으로 대체합니다.

### 히스토리 컨텍스트

- `channels.slack.historyLimit` (또는 `channels.slack.accounts.*.historyLimit`) 는 최근 채널/그룹 메시지를 프롬프트에 포함할 개수를 제어합니다.
- `messages.groupChat.historyLimit` 로 대체됩니다. 비활성화하려면 `0` 를 설정하십시오 (기본값 50).

## HTTP 모드 (Events API)

Gateway(게이트웨이) 가 HTTPS 를 통해 Slack 에서 접근 가능한 경우 (일반적인 서버 배포) HTTP 웹훅 모드를 사용합니다.
HTTP 모드는 Events API + Interactivity + Slash Commands 를 공유 요청 URL 로 사용합니다.

### 설정 (HTTP 모드)

1. Slack 앱을 생성하고 **Socket Mode** 를 비활성화합니다 (HTTP 만 사용하는 경우 선택 사항).
2. **Basic Information** → **Signing Secret** 을 복사합니다.
3. **OAuth & Permissions** → 앱을 설치하고 **Bot User OAuth Token** (`xoxb-...`) 을 복사합니다.
4. **Event Subscriptions** → 이벤트를 활성화하고 **Request URL** 을 Gateway(게이트웨이) 웹훅 경로로 설정합니다 (기본값 `/slack/events`).
5. **Interactivity & Shortcuts** → 활성화하고 동일한 **Request URL** 을 설정합니다.
6. **Slash Commands** → 명령에 대해 동일한 **Request URL** 을 설정합니다.

요청 URL 예시:
`https://gateway-host/slack/events`

### OpenClaw 설정 (최소)

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

다중 계정 HTTP 모드: `channels.slack.accounts.<id>.mode = "http"` 를 설정하고 각 계정마다 고유한 `webhookPath` 를 제공하여 각 Slack 앱이 자체 URL 을 가리키도록 합니다.

### 매니페스트 (선택 사항)

이 Slack 앱 매니페스트를 사용하면 앱을 빠르게 생성할 수 있습니다 (원하는 경우 이름/명령을 조정). 사용자 토큰을 구성할 계획이라면 사용자 범위를 포함하십시오.

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

네이티브 명령을 활성화하는 경우, 노출하려는 각 명령마다 하나의 `slash_commands` 항목을 추가합니다 (`/help` 목록과 일치). `channels.slack.commands.native` 로 재정의할 수 있습니다.

## 범위 (현재 vs 선택)

Slack Conversations API 는 타입별 범위를 사용합니다. 실제로 사용하는 대화 타입 (channels, groups, im, mpim) 에 필요한 범위만 있으면 됩니다. 개요는 [https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) 를 참조하십시오.

### 봇 토큰 범위 (필수)

- `chat:write` (`chat.postMessage` 를 통한 메시지 전송/업데이트/삭제)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (사용자 다이렉트 메시지 를 위해 `conversations.open` 로 DM 열기)
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
- `files:write` (`files.uploadV2` 를 통한 업로드)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### 사용자 토큰 범위 (선택, 기본 읽기 전용)

`channels.slack.userToken` 를 구성하는 경우 **User Token Scopes** 아래에 추가합니다.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### 오늘은 필요 없음 (하지만 향후 필요할 가능성 있음)

- `mpim:write` (`conversations.open` 를 통한 그룹 DM 열기/DM 시작을 추가하는 경우에만)
- `groups:write` (비공개 채널 관리: 생성/이름 변경/초대/보관을 추가하는 경우에만)
- `chat:write.public` (봇이 참여하지 않은 채널에 게시하려는 경우에만)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (`users.info` 에서 이메일 필드가 필요한 경우에만)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (파일 메타데이터를 나열/읽기 시작하는 경우에만)

## 설정

Slack 는 Socket 모드만 사용합니다 (HTTP 웹훅 서버 없음). 두 토큰을 모두 제공하십시오:

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

토큰은 환경 변수를 통해서도 제공할 수 있습니다:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack 반응은 `messages.ackReaction` +
`messages.ackReactionScope` 로 전역 제어됩니다. 봇이 응답한 후 ack 반응을 지우려면 `messages.removeAckAfterReply` 를 사용하십시오.

## 제한

- 발신 텍스트는 `channels.slack.textChunkLimit` 로 분할됩니다 (기본값 4000).
- 선택적 줄바꿈 분할: 길이 분할 전에 빈 줄 (문단 경계) 기준으로 분할하려면 `channels.slack.chunkMode="newline"` 를 설정합니다.
- 미디어 업로드는 `channels.slack.mediaMaxMb` 로 제한됩니다 (기본값 20).

## 답글 스레딩

기본적으로 OpenClaw 는 메인 채널에 답글을 보냅니다. 자동 스레딩을 제어하려면 `channels.slack.replyToMode` 를 사용하십시오:

| 모드      | 동작                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **기본값.** 메인 채널에 답글. 트리거 메시지가 이미 스레드인 경우에만 스레드로 답글합니다.                                     |
| `first` | 첫 번째 답글은 스레드 (트리거 메시지 아래) 로 보내고, 이후 답글은 메인 채널로 보냅니다. 컨텍스트를 유지하면서 스레드 난잡함을 줄이는 데 유용합니다. |
| `all`   | 모든 답글을 스레드로 보냅니다. 대화를 한 곳에 유지하지만 가시성이 낮아질 수 있습니다.                                                         |

이 모드는 자동 응답과 에이전트 도구 호출 (`slack sendMessage`) 모두에 적용됩니다.

### 채팅 유형별 스레딩

`channels.slack.replyToModeByChatType` 를 설정하여 채팅 유형별로 다른 스레딩 동작을 구성할 수 있습니다:

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

- `direct`: 1:1 다이렉트 메시지 (Slack `im`)
- `group`: 그룹 다이렉트 메시지 / MPIM (Slack `mpim`)
- `channel`: 일반 채널 (공개/비공개)

우선순위:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. 프로바이더 기본값 (`off`)

레거시 `channels.slack.dm.replyToMode` 는 채팅 유형 재정의가 설정되지 않은 경우 `direct` 에 대한 폴백으로 여전히 허용됩니다.

예시:

다이렉트 메시지 만 스레드로 처리:

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

그룹 다이렉트 메시지 는 스레드로, 채널은 루트 유지:

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

채널은 스레드로, 다이렉트 메시지 는 루트 유지:

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

세밀한 제어를 위해 에이전트 응답에서 다음 태그를 사용하십시오:

- `[[reply_to_current]]` — 트리거 메시지에 답글 (스레드 시작/유지).
- `[[reply_to:<id>]]` — 특정 메시지 ID 에 답글.

## 세션 + 라우팅

- 다이렉트 메시지 는 `main` 세션을 공유합니다 (WhatsApp/Telegram 과 유사).
- 채널은 `agent:<agentId>:slack:channel:<channelId>` 세션에 매핑됩니다.
- Slash 명령은 `agent:<agentId>:slack:slash:<userId>` 세션을 사용합니다 (접두사는 `channels.slack.slashCommand.sessionPrefix` 로 구성 가능).
- Slack 이 `channel_type` 를 제공하지 않는 경우, OpenClaw 는 채널 ID 접두사 (`D`, `C`, `G`) 로부터 이를 추론하고 세션 키를 안정적으로 유지하기 위해 기본값 `channel` 를 사용합니다.
- 네이티브 명령 등록은 `commands.native` (전역 기본값 `"auto"` → Slack 끔) 을 사용하며, 작업공간별로 `channels.slack.commands.native` 로 재정의할 수 있습니다. 텍스트 명령은 독립형 `/...` 메시지가 필요하며 `commands.text: false` 로 비활성화할 수 있습니다. Slack 슬래시 명령은 Slack 앱에서 관리되며 자동으로 제거되지 않습니다. 명령에 대한 접근 그룹 검사를 우회하려면 `commands.useAccessGroups: false` 를 사용하십시오.
- 전체 명령 목록 + 설정: [Slash commands](/tools/slash-commands)

## 다이렉트 메시지 보안 (페어링)

- 기본값: `channels.slack.dm.policy="pairing"` — 알 수 없는 다이렉트 메시지 발신자는 페어링 코드 (1 시간 후 만료) 를 받습니다.
- 승인 방법: `openclaw pairing approve slack <code>`.
- 누구나 허용하려면 `channels.slack.dm.policy="open"` 와 `channels.slack.dm.allowFrom=["*"]` 를 설정하십시오.
- `channels.slack.dm.allowFrom` 는 사용자 ID, @핸들, 또는 이메일을 허용합니다 (토큰이 허용하는 경우 시작 시 해석). 마법사는 설정 중 토큰이 허용하면 사용자명을 받아 ID 로 해석합니다.

## 그룹 정책

- `channels.slack.groupPolicy` 는 채널 처리를 제어합니다 (`open|disabled|allowlist`).
- `allowlist` 는 채널이 `channels.slack.channels` 에 나열되어 있을 것을 요구합니다.
- `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` 만 설정하고 `channels.slack` 섹션을 생성하지 않으면,
  런타임 기본값으로 `groupPolicy` 가 `open` 로 설정됩니다. 이를 잠그려면 `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, 또는 채널 허용 목록을 추가하십시오.
- 구성 마법사는 `#channel` 이름을 허용하고 가능한 경우 ID 로 해석합니다
  (공개 + 비공개). 여러 항목이 일치하면 활성 채널을 우선합니다.
- 시작 시 OpenClaw 는 허용 목록의 채널/사용자 이름을 ID 로 해석하고 (토큰이 허용하는 경우)
  매핑을 로그에 기록하며, 해석되지 않은 항목은 입력된 그대로 유지합니다.
- **채널을 전혀 허용하지 않으려면**, `channels.slack.groupPolicy: "disabled"` 를 설정하십시오 (또는 빈 허용 목록 유지).

채널 옵션 (`channels.slack.channels.<id>` 또는 `channels.slack.channels.<name>`):

- `allow`: `groupPolicy="allowlist"` 일 때 채널 허용/차단.
- `requireMention`: 채널에 대한 멘션 게이팅.
- `tools`: 선택적 채널별 도구 정책 재정의 (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: 채널 내 발신자별 도구 정책 재정의 (키는 발신자 ID/@핸들/이메일; `"*"` 와일드카드 지원).
- `allowBots`: 이 채널에서 봇 작성 메시지 허용 (기본값: false).
- `users`: 선택적 채널별 사용자 허용 목록.
- `skills`: 스킬 필터 (생략 = 모든 Skills, 비어 있음 = 없음).
- `systemPrompt`: 채널용 추가 시스템 프롬프트 (주제/목적과 결합).
- `enabled`: `false` 를 설정하여 채널 비활성화.

## 전달 대상

cron/CLI 전송 시 다음을 사용하십시오:

- 다이렉트 메시지 용 `user:<id>`
- 채널 용 `channel:<id>`

## 도구 작업

Slack 도구 작업은 `channels.slack.actions.*` 로 게이팅할 수 있습니다:

| 작업 그룹      | 기본값     | 참고            |
| ---------- | ------- | ------------- |
| reactions  | enabled | 반응 추가 + 목록    |
| messages   | enabled | 읽기/전송/편집/삭제   |
| pins       | enabled | 고정/해제/목록      |
| memberInfo | enabled | 멤버 정보         |
| emojiList  | enabled | 사용자 지정 이모지 목록 |

## 보안 참고 사항

- 쓰기는 기본적으로 봇 토큰을 사용하여 상태 변경 작업이
  앱의 봇 권한과 식별자 범위 내에 유지되도록 합니다.
- `userTokenReadOnly: false` 를 설정하면 봇 토큰을 사용할 수 없을 때 사용자 토큰을
  쓰기 작업에 사용할 수 있으며, 이는 설치 사용자의 접근 권한으로 작업이 실행됨을 의미합니다. 사용자 토큰은 매우 높은 권한을 가지므로
  작업 게이트와 허용 목록을 엄격히 관리하십시오.
- 사용자 토큰 쓰기를 활성화하는 경우, 사용자 토큰에 예상되는 쓰기 범위 (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) 가 포함되어 있는지 확인하십시오.

## 문제 해결

다음 순서를 먼저 실행하십시오:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

그런 다음 필요 시 다이렉트 메시지 페어링 상태를 확인하십시오:

```bash
openclaw pairing list slack
```

일반적인 실패 사례:

- 연결되었지만 채널 응답이 없음: `groupPolicy` 에 의해 채널이 차단되었거나 `channels.slack.channels` 허용 목록에 없음.
- 다이렉트 메시지 무시됨: `channels.slack.dm.policy="pairing"` 일 때 발신자가 승인되지 않음.
- API 오류 (`missing_scope`, `not_in_channel`, 인증 실패): 봇/앱 토큰 또는 Slack 범위가 불완전함.

트리아지 흐름: [/channels/troubleshooting](/channels/troubleshooting).

## 참고

- 멘션 게이팅은 `channels.slack.channels` 로 제어됩니다 (`requireMention` 를 `true` 로 설정). `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`) 도 멘션으로 계산됩니다.
- 다중 에이전트 재정의: `agents.list[].groupChat.mentionPatterns` 에 에이전트별 패턴을 설정하십시오.
- 반응 알림은 `channels.slack.reactionNotifications` 를 따릅니다 (`reactionAllowlist` 를 `allowlist` 모드와 함께 사용).
- 봇 작성 메시지는 기본적으로 무시됩니다. `channels.slack.allowBots` 또는 `channels.slack.channels.<id> .allowBots` 로 활성화하십시오..allowBots\`.
- 경고: 다른 봇에 대한 답글을 허용하는 경우 (`channels.slack.allowBots=true` 또는 `channels.slack.channels.<id>.allowBots=true`), `requireMention`, `channels.slack.channels.<id>.users` 허용 목록 및/또는 `AGENTS.md` 와 `SOUL.md` 의 명확한 가드레일로 봇 간 무한 답글 루프를 방지하십시오.
- Slack 도구의 반응 제거 의미론은 [/tools/reactions](/tools/reactions) 를 참조하십시오.
- 첨부 파일은 허용되고 크기 제한 내인 경우 미디어 저장소로 다운로드됩니다.
