---
title: "Configuration Reference"
description: "Complete field-by-field reference for ~/.openclaw/openclaw.json"
x-i18n:
  source_hash: fcefaacfddf99251309d8ea651285d37b1e3c2edb0823ac23133289e0d4de1f6
---

# 구성 참조

`~/.openclaw/openclaw.json`에서 모든 필드를 사용할 수 있습니다. 작업 중심 개요는 [구성](/gateway/configuration)을 참조하세요.

구성 형식은 **JSON5**(주석 + 후행 쉼표 허용)입니다. 모든 필드는 선택 사항입니다. OpenClaw는 생략 시 안전한 기본값을 사용합니다.

---

## 채널

각 채널은 구성 섹션이 존재하면 자동으로 시작됩니다(`enabled: false` 제외).

### DM 및 그룹접속

모든 채널은 DM 정책 및 그룹 정책을 지원합니다.

| DM 정책            | 행동                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `pairing` (기본값) | 알 수 없는 발신자는 일회성 페어링 코드를 받습니다. 소유자가 승인해야 함 |
| `allowlist`        | `allowFrom`(또는 페어링된 저장소 허용)의 보낸 사람만                    |
| `open`             | 모든 인바운드 DM 허용(`allowFrom: ["*"]` 필요)                          |
| `disabled`         | 모든 인바운드 DM 무시                                                   |

| 그룹 정책            | 행동                                           |
| -------------------- | ---------------------------------------------- |
| `allowlist` (기본값) | 구성된 허용 목록과 일치하는 그룹만             |
| `open`               | 그룹 허용 목록 우회(멘션 게이팅이 계속 적용됨) |
| `disabled`           | 모든 그룹/방 메시지 차단                       |

<Note>
`channels.defaults.groupPolicy`는 공급자의 `groupPolicy`가 설정되지 않은 경우 기본값을 설정합니다.
페어링 코드는 1시간 후에 만료됩니다. 보류 중인 DM 페어링 요청은 **채널당 3**으로 제한됩니다.
Slack/Discord에는 특별한 대체 기능이 있습니다. 해당 제공자 섹션이 완전히 누락된 경우 런타임 그룹 정책은 `open`(시작 경고와 함께)로 해결될 수 있습니다.
</Note>

### 왓츠앱

WhatsApp은 게이트웨이의 웹 채널(Baileys Web)을 통해 실행됩니다. 연결된 세션이 있으면 자동으로 시작됩니다.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000,
      chunkMode: "length", // length | newline
      mediaMaxMb: 50,
      sendReadReceipts: true, // blue ticks (false in self-chat mode)
      groups: {
        "*": { requireMention: true },
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

<Accordion title="Multi-account WhatsApp">

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {},
        personal: {},
        biz: {
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

    - 아웃바운드 명령이 있는 경우 기본적으로 `default` 계정으로 설정됩니다. 그렇지 않으면 처음 구성된 계정 ID(정렬됨)입니다.
    - 레거시 단일 계정 Baileys 인증 디렉토리는 `openclaw doctor`에 의해 `whatsapp/default`로 마이그레이션되었습니다.
    - 계정별 재정의: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

</Accordion>

### 텔레그램

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing",
      allowFrom: ["tg:123456789"],
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50,
      replyToMode: "first", // off | first | all
      linkPreview: true,
      streamMode: "partial", // off | partial | block
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true },
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: { autoSelectFamily: false },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

- 봇 토큰: `channels.telegram.botToken` 또는 `channels.telegram.tokenFile`, `TELEGRAM_BOT_TOKEN`를 기본 계정으로 대체합니다.
- `configWrites: false`는 텔레그램에서 시작한 구성 쓰기(수퍼그룹 ID 마이그레이션, `/config set|unset`)를 차단합니다.
- 드래프트 스트리밍은 텔레그램 `sendMessageDraft`을 사용합니다(비공개 채팅 주제 필요).
- 재시도 정책: [재시도 정책](/concepts/retry)을 참고하세요.

### 불화

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8,
      allowBots: false,
      actions: {
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["1234567890", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20,
      textChunkLimit: 2000,
      chunkMode: "length", // length | newline
      maxLinesPerMessage: 17,
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

- 토큰: `channels.discord.token`, 기본 계정에 대한 대체 수단으로 `DISCORD_BOT_TOKEN` 포함.
- 배송 대상은 `user:<id>`(DM) 또는 `channel:<id>`(길드 채널)을 사용하세요. 단순한 숫자 ID는 거부됩니다.
- 길드 슬러그는 소문자이며 공백은 `-`로 대체됩니다. 채널 키는 슬러그 이름을 사용합니다(`#` 없음). 길드 ID를 선호합니다.
- 봇이 작성한 메시지는 기본적으로 무시됩니다. `allowBots: true` 이를 활성화합니다(자신의 메시지는 여전히 필터링됨).
- `maxLinesPerMessage` (기본값 17)은 2000자 미만인 경우에도 긴 메시지를 분할합니다.

**반응 알림 모드:** `off` (없음), `own` (봇의 메시지, 기본값), `all` (모든 메시지), `allowlist` (모든 메시지에서 `guilds.<id>.users`).

### Google 채팅

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890",
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

- 서비스 계정 JSON: 인라인(`serviceAccount`) 또는 파일 기반(`serviceAccountFile`).
- 환경 대체: `GOOGLE_CHAT_SERVICE_ACCOUNT` 또는 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- 배송 대상은 `spaces/<spaceId>` 또는 `users/<userId|email>`를 사용하세요.

### 슬랙

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing",
        allowFrom: ["U123", "U456", "*"],
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50,
      allowBots: false,
      reactionNotifications: "own",
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

- **소켓 모드**에는 기본 계정 환경 대체를 위해 `botToken` 및 `appToken` (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`가 모두 필요합니다.)
- **HTTP 모드**에는 `botToken`와 `signingSecret`가 필요합니다(루트 또는 계정별).
- `configWrites: false`는 Slack에서 시작한 구성 쓰기를 차단합니다.
- 배송 대상은 `user:<id>`(DM) 또는 `channel:<id>`를 사용하세요.

**반응 알림 모드:** `off`, `own` (기본값), `all`, `allowlist` (`reactionAllowlist`에서).

**스레드 세션 격리:** `thread.historyScope`는 스레드별로(기본값) 또는 채널 전체에서 공유됩니다. `thread.inheritParent` 상위 채널 기록을 새 스레드에 복사합니다.

| 액션 그룹     | 기본값 | 메모                  |
| ------------- | ------ | --------------------- |
| 반응          | 활성화 | 반응 + 목록 반응      |
| 메시지        | 활성화 | 읽기/보내기/수정/삭제 |
| 핀            | 활성화 | 고정/고정 해제/목록   |
| 회원정보      | 활성화 | 회원정보              |
| 이모티콘 목록 | 활성화 | 맞춤 이모티콘 목록    |

### 가장 중요함

Mattermost는 플러그인으로 제공됩니다: `openclaw plugins install @openclaw/mattermost`.

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

채팅 모드: `oncall`(@멘션에 응답, 기본값), `onmessage`(모든 메시지), `onchar`(트리거 접두사로 시작하는 메시지).

### 시그널

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50,
    },
  },
}
```

**반응 알림 모드:** `off`, `own` (기본값), `all`, `allowlist` (`reactionAllowlist`에서).

### 아이메시지

OpenClaw는 `imsg rpc`(stdio를 통한 JSON-RPC)를 생성합니다. 데몬이나 포트가 필요하지 않습니다.

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host",
      dmPolicy: "pairing",
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50,
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

- 메시지 DB에 대한 전체 디스크 액세스가 필요합니다.
- `chat_id:<id>` 대상을 선호합니다. `imsg chats --limit 20`를 사용하여 채팅 목록을 표시하세요.
- `cliPath`는 SSH 래퍼를 가리킬 수 있습니다. SCP 첨부 파일 가져오기를 위해 `remoteHost`를 설정합니다.

<Accordion title="iMessage SSH wrapper example">

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

</Accordion>

### 다중 계정(모든 채널)

채널당 여러 계정을 실행하세요(각각 고유한 `accountId` 포함).

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

- `default`는 `accountId`가 생략된 경우(CLI + 라우팅) 사용됩니다.
- Env 토큰은 **기본** 계정에만 적용됩니다.
- 기본 채널 설정은 계정별로 재정의되지 않는 한 모든 계정에 적용됩니다.
- `bindings[].match.accountId`를 사용하여 각 계정을 다른 에이전트로 라우팅합니다.

### 그룹채팅 멘션 게이팅

그룹 메시지는 기본적으로 **멘션 필요**(메타데이터 언급 또는 정규식 패턴)로 설정됩니다. WhatsApp, Telegram, Discord, Google Chat, iMessage 그룹 채팅에 적용됩니다.

**멘션 유형:**

- **메타데이터 언급**: 기본 플랫폼 @-멘션. WhatsApp 셀프 채팅 모드에서는 무시됩니다.
- **텍스트 패턴**: `agents.list[].groupChat.mentionPatterns`의 정규식 패턴입니다. 항상 확인합니다.
- 멘션 게이팅은 탐지가 가능한 경우에만 시행됩니다(네이티브 멘션 또는 하나 이상의 패턴).

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit`는 전역 기본값을 설정합니다. 채널은 `channels.<channel>.historyLimit`(또는 계정별)로 재정의할 수 있습니다. 비활성화하려면 `0`를 설정하세요.

#### DM 기록 제한

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30,
      dms: {
        "123456789": { historyLimit: 50 },
      },
    },
  },
}
```

해결 방법: DM별 재정의 → 공급자 기본값 → 제한 없음(모두 유지됨)

지원됨: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

#### 셀프 채팅 모드

셀프 채팅 모드를 활성화하려면 `allowFrom`에 자신의 전화번호를 포함하세요(기본 @멘션을 무시하고 텍스트 패턴에만 응답함).

```json5
{
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["reisponde", "@openclaw"] },
      },
    ],
  },
}
```

### 명령(채팅 명령 처리)

```json5
{
  commands: {
    native: "auto", // register native commands when supported
    text: true, // parse /commands in chat messages
    bash: false, // allow ! (alias: /bash)
    bashForegroundMs: 2000,
    config: false, // allow /config
    debug: false, // allow /debug
    restart: false, // allow /restart + gateway restart tool
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

<Accordion title="Command details">

    - 텍스트 명령은 `/`로 시작하는 **독립형** 메시지여야 합니다.
    - `native: "auto"`는 Discord/Telegram에 대한 기본 명령을 활성화하고 Slack은 비활성화합니다.
    - 채널별 재정의: `channels.discord.commands.native` (bool 또는 `"auto"`). `false` 이전에 등록된 명령을 삭제합니다.
    - `channels.telegram.customCommands`는 텔레그램 봇 메뉴 항목을 추가합니다.
    - `bash: true`는 호스트 쉘에 대해 `! <cmd>`를 활성화합니다. `tools.elevated.enabled`와 `tools.elevated.allowFrom.<channel>`의 발신자가 필요합니다.
    - `config: true`는 `/config`를 활성화합니다(`openclaw.json` 읽기/쓰기).
    - `channels.<provider>.configWrites` 채널당 게이트 구성 돌연변이를 지정합니다(기본값: true).
    - `allowFrom`는 공급자별입니다. 설정되면 **유일한** 인증 소스입니다(채널 허용 목록/페어링 및 `useAccessGroups`는 무시됩니다).
    - `useAccessGroups: false`는 `allowFrom`가 설정되지 않은 경우 명령이 액세스 그룹 정책을 우회하도록 허용합니다.

</Accordion>

---

## 에이전트 기본값

### `agents.defaults.workspace`

기본값: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

### `agents.defaults.repoRoot`

시스템 프롬프트의 런타임 라인에 표시된 선택적 저장소 루트입니다. 설정하지 않으면 OpenClaw가 작업 공간에서 위쪽으로 걸어가면서 자동 감지합니다.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

작업공간 부트스트랩 파일(`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`)의 자동 생성을 비활성화합니다.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

자르기 전 작업공간 부트스트랩 파일당 최대 문자 수입니다. 기본값: `20000`.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

시스템 프롬프트 컨텍스트의 시간대(메시지 타임스탬프 아님) 호스트 시간대로 돌아갑니다.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

시스템 프롬프트의 시간 형식입니다. 기본값: `auto` (OS 기본 설정).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `agents.defaults.model`

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      contextTokens: 200000,
      maxConcurrent: 3,
    },
  },
}
```

- `model.primary`: 형식 `provider/model` (예: `anthropic/claude-opus-4-6`). 공급자를 생략하면 OpenClaw는 `anthropic`(더 이상 사용되지 않음)로 가정합니다.
- `models`: `/model`에 대해 구성된 모델 카탈로그 및 허용 목록입니다. 각 항목에는 `alias`(바로가기) 및 `params`(공급자별: `temperature`, `maxTokens`)가 포함될 수 있습니다.
- `imageModel`: 기본 모델에 이미지 입력이 부족한 경우에만 사용됩니다.
- `maxConcurrent`: 세션 전체에 걸쳐 최대 병렬 에이전트가 실행됩니다(각 세션은 여전히 ​​직렬화됨). 기본값: 1.

**내장 별칭 속기**(모델이 `agents.defaults.models`에 있는 경우에만 적용):

| 별칭           | 모델                            |
| -------------- | ------------------------------- |
| `opus`         | `anthropic/claude-opus-4-6`     |
| `sonnet`       | `anthropic/claude-sonnet-4-5`   |
| `gpt`          | `openai/gpt-5.2`                |
| `gpt-mini`     | `openai/gpt-5-mini`             |
| `gemini`       | `google/gemini-3-pro-preview`   |
| `gemini-flash` | `google/gemini-3-flash-preview` |

구성된 별칭은 항상 기본값보다 우선합니다.

Z.AI GLM-4.x 모델은 `--thinking off`를 설정하거나 `agents.defaults.models["zai/<model>"].params.thinking`를 직접 정의하지 않는 한 자동으로 사고 모드를 활성화합니다.

### `agents.defaults.cliBackends`

텍스트 전용 대체 실행을 위한 선택적 CLI 백엔드(도구 호출 없음). API 공급자가 실패할 때 백업으로 유용합니다.

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

- CLI 백엔드는 텍스트 우선입니다. 도구는 항상 비활성화되어 있습니다.
- `sessionArg` 설정 시 지원되는 세션입니다.
- `imageArg`에서 파일 경로를 허용하는 경우 이미지 통과가 지원됩니다.

### `agents.defaults.heartbeat`

주기적으로 하트비트가 실행됩니다.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 0m disables
        model: "openai/gpt-5.2-mini",
        includeReasoning: false,
        session: "main",
        to: "+15555550123",
        target: "last", // last | whatsapp | telegram | discord | ... | none
        prompt: "Read HEARTBEAT.md if it exists...",
        ackMaxChars: 300,
      },
    },
  },
}
```

- `every`: 기간 문자열(ms/s/m/h). 기본값: `30m`.
- 에이전트별: `agents.list[].heartbeat`를 설정합니다. 에이전트가 `heartbeat`를 정의하면 **해당 에이전트**만 하트비트를 실행합니다.
- 하트비트는 전체 에이전트 회전을 실행합니다. 간격이 짧을수록 더 많은 토큰이 소모됩니다.

### `agents.defaults.compaction`

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard", // default | safeguard
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

- `mode`: `default` 또는 `safeguard` (오랜 역사에 대한 청크 요약). [압축](/concepts/compaction)을 참조하세요.
- `memoryFlush`: 내구성 있는 메모리를 저장하기 위해 자동 압축 전에 자동 에이전트 회전을 수행합니다. 작업공간이 읽기 전용인 경우 건너뜁니다.

### `agents.defaults.contextPruning`

LLM으로 보내기 전에 메모리 내 컨텍스트에서 **이전 도구 결과**를 정리합니다. 디스크의 세션 기록을 수정하지 **않습니다**.

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl", // off | cache-ttl
        ttl: "1h", // duration (ms/s/m/h), default unit: minutes
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

<Accordion title="cache-ttl mode behavior">

    - `mode: "cache-ttl"`는 가지치기 패스를 활성화합니다.
    - `ttl` 정리가 다시 실행될 수 있는 빈도를 제어합니다(마지막 캐시 터치 후).
    - 가지치기는 먼저 대형 도구 결과를 소프트 트림한 다음 필요한 경우 오래된 도구 결과를 강제 삭제합니다.

    **소프트 트림**은 시작 + 끝을 유지하고 중간에 `...`를 삽입합니다.

    **강제 삭제**는 전체 도구 결과를 자리 표시자로 대체합니다.

    참고:

    - 이미지 블록은 자르거나 지워지지 않습니다.
    - 비율은 정확한 토큰 수가 아닌 문자 기반(대략)입니다.
    - 보조 메시지가 `keepLastAssistants`개 미만일 경우 정리를 건너뜁니다.

</Accordion>

동작에 대한 자세한 내용은 [세션 정리](/concepts/session-pruning)를 참조하세요.

### 스트리밍 차단

```json5
{
  agents: {
    defaults: {
      blockStreamingDefault: "off", // on | off
      blockStreamingBreak: "text_end", // text_end | message_end
      blockStreamingChunk: { minChars: 800, maxChars: 1200 },
      blockStreamingCoalesce: { idleMs: 1000 },
      humanDelay: { mode: "natural" }, // off | natural | custom (use minMs/maxMs)
    },
  },
}
```

- 텔레그램이 아닌 채널에서는 차단 응답을 활성화하려면 명시적인 `*.blockStreaming: true`가 필요합니다.
- 채널 재정의: `channels.<channel>.blockStreamingCoalesce` (및 계정별 변형). Signal/Slack/Discord/Google Chat 기본 `minChars: 1500`.
- `humanDelay`: 블록 응답 사이의 무작위 일시 중지입니다. `natural` = 800–2500ms. 에이전트별 재정의: `agents.list[].humanDelay`.

동작 + 청킹 세부정보는 [스트리밍](/concepts/streaming)을 참조하세요.

### 입력 표시

```json5
{
  agents: {
    defaults: {
      typingMode: "instant", // never | instant | thinking | message
      typingIntervalSeconds: 6,
    },
  },
}
```

- 기본값: 직접 채팅/멘션의 경우 `instant`, 언급되지 않은 그룹 채팅의 경우 `message`.
- 세션별 재정의: `session.typingMode`, `session.typingIntervalSeconds`.

[입력 표시](/concepts/typing-indicators)를 참조하세요.

### `agents.defaults.sandbox`

내장된 에이전트에 대한 선택적인 **Docker 샌드박싱**. 전체 가이드는 [샌드박싱](/gateway/sandboxing)을 참조하세요.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24,
          maxAgeDays: 7,
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

<Accordion title="Sandbox details">

    **작업 공간 액세스:**

    - `none`: `~/.openclaw/sandboxes` 아래 범위별 샌드박스 작업공간
    - `ro`: `/workspace`의 샌드박스 작업공간, `/agent`에 읽기 전용으로 마운트된 에이전트 작업공간
    - `rw`: 에이전트 작업 영역이 `/workspace`에 읽기/쓰기가 마운트되었습니다.

    **범위:**

    - `session`: 세션별 컨테이너 + 작업공간
    - `agent`: 에이전트당 컨테이너 1개 + 작업공간(기본값)
    - `shared`: 공유 컨테이너 및 작업 공간(세션 간 격리 없음)

**`setupCommand`** 컨테이너 생성 후 (`sh -lc`를 통해) 한 번 실행됩니다. 네트워크 송신, 쓰기 가능한 루트, 루트 사용자가 필요합니다.

**컨테이너 기본값은 `network: "none"`** — 에이전트에 아웃바운드 액세스가 필요한 경우 `"bridge"`로 설정됩니다.

**인바운드 첨부 파일**은 활성 작업공간의 `media/inbound/*`에 준비됩니다.

**`docker.binds`** 추가 호스트 디렉터리를 마운트합니다. 전역 및 에이전트별 바인딩이 병합됩니다.

**샌드박스 브라우저** (`sandbox.browser.enabled`): Chromium + CDP가 컨테이너에 포함되어 있습니다. noVNC URL이 시스템 프롬프트에 삽입되었습니다. 기본 구성에는 `browser.enabled`가 필요하지 않습니다.

    - `allowHostControl: false`(기본값)은 샌드박스 세션이 호스트 브라우저를 대상으로 하지 못하도록 차단합니다.

</Accordion>

이미지 빌드:

```bash
scripts/sandbox-setup.sh           # main sandbox image
scripts/sandbox-browser-setup.sh   # optional browser image
```

### `agents.list` (에이전트별 재정의)

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        name: "Main Agent",
        workspace: "~/.openclaw/workspace",
        agentDir: "~/.openclaw/agents/main/agent",
        model: "anthropic/claude-opus-4-6", // or { primary, fallbacks }
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
        groupChat: { mentionPatterns: ["@openclaw"] },
        sandbox: { mode: "off" },
        subagents: { allowAgents: ["*"] },
        tools: {
          profile: "coding",
          allow: ["browser"],
          deny: ["canvas"],
          elevated: { enabled: true },
        },
      },
    ],
  },
}
```

- `id` : 안정적인 에이전트 ID(필수).
- `default`: 여러 개 설정되면 먼저 승리합니다(경고 기록). 아무것도 설정되지 않은 경우 첫 번째 목록 항목이 기본값입니다.
- `model`: 문자열 형식은 `primary`만 재정의합니다. 객체 형태 `{ primary, fallbacks }`는 둘 다 무시합니다(`[]`는 전역 폴백을 비활성화합니다).
- `identity.avatar`: 작업공간 상대 경로, `http(s)` URL 또는 `data:` URI.
- `identity`는 `ackReaction`에서 `emoji`, `mentionPatterns`에서 `name`/`emoji`의 기본값을 파생합니다.
- `subagents.allowAgents`: `sessions_spawn`에 대한 에이전트 ID 허용 목록(`["*"]` = 모두, 기본값: 동일한 에이전트만).

---

## 다중 에이전트 라우팅

하나의 게이트웨이 내에서 여러 개의 격리된 에이전트를 실행합니다. [다중 에이전트](/concepts/multi-agent)를 참조하세요.

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
}
```

### 일치 필드 바인딩

- `match.channel` (필수)
- `match.accountId` (선택 사항; `*` = 모든 계정; 생략 = 기본 계정)
- `match.peer` (선택 사항; `{ kind: direct|group|channel, id }`)
- `match.guildId` / `match.teamId` (선택 사항, 채널별)

**확정적 일치 순서:**

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (정확히, 동료/길드/팀 없음)
5. `match.accountId: "*"` (채널 전체)
6. 기본 에이전트

각 계층 내에서 처음으로 일치하는 `bindings` 항목이 승리합니다.

### 에이전트별 액세스 프로필

<Accordion title="Full access (no sandbox)">

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

</Accordion>

<Accordion title="Read-only tools + workspace">

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

</Accordion>

<Accordion title="No filesystem access (messaging only)">

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

</Accordion>

우선순위에 대한 자세한 내용은 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools)를 참조하세요.

---

## 세션

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main", // main | per-peer | per-channel-peer | per-account-channel-peer
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily", // daily | idle
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    maintenance: {
      mode: "warn", // warn | enforce
      pruneAfter: "30d",
      maxEntries: 500,
      rotateBytes: "10mb",
    },
    mainKey: "main", // legacy (runtime always uses "main")
    agentToAgent: { maxPingPongTurns: 5 },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

<Accordion title="Session field details">

    - **`dmScope`**: DM을 그룹화하는 방법입니다.
      - `main`: 모든 DM이 기본 세션을 공유합니다.
      - `per-peer`: 채널 전반에 걸쳐 보낸 사람 ID로 격리합니다.
      - `per-channel-peer`: 채널 + 발신자별로 격리합니다(다중 사용자 받은 편지함에 권장).
      - `per-account-channel-peer`: 계정 + 채널 + 발신자별로 격리합니다(다중 계정 권장).
    - **`identityLinks`**: 교차 채널 세션 공유를 위해 정식 ID를 공급자 접두사가 붙은 피어에 매핑합니다.
    - **`reset`**: 1차 재설정 정책입니다. `daily`는 `atHour` 현지 시간에 재설정됩니다. `idle`는 `idleMinutes` 이후에 재설정됩니다. 둘 다 구성하면 먼저 만료되는 쪽이 우선합니다.
    - **`resetByType`**: 유형별 재정의(`direct`, `group`, `thread`). 레거시 `dm`가 `direct`의 별칭으로 허용됩니다.
    - **`mainKey`**: 레거시 필드. 이제 런타임은 기본 직접 채팅 버킷에 항상 `"main"`를 사용합니다.
    - **`sendPolicy`**: `channel`, `chatType` (`direct|group|channel`, 레거시 `dm` 별칭) 또는 `keyPrefix`로 일치합니다. 먼저 거부하면 승리합니다.
    - **`maintenance`**: `warn`는 제거 시 활성 세션에 경고합니다. `enforce` 가지치기 및 회전을 적용합니다.

</Accordion>

---

## 메시지

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions", // group-mentions | group-all | direct | all
    removeAckAfterReply: false,
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog | steer+backlog | queue | interrupt
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
      },
    },
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
      },
    },
  },
}
```

### 응답 접두사

채널별/계정 재정의: `channels.<channel>.responsePrefix`, `channels.<channel>.accounts.<id>.responsePrefix`.

해결 방법(가장 구체적인 성공): 계정 → 채널 → 글로벌. `""` 캐스케이드를 비활성화하고 중지합니다. `"auto"`는 `[{identity.name}]`를 파생합니다.

**템플릿 변수:**

| 변수              | 설명               | 예                          |
| ----------------- | ------------------ | --------------------------- |
| `{model}`         | 짧은 모델 이름     | `claude-opus-4-6`           |
| `{modelFull}`     | 전체 모델 식별자   | `anthropic/claude-opus-4-6` |
| `{provider}`      | 제공자 이름        | `anthropic`                 |
| `{thinkingLevel}` | 현재 사고수준      | `high`, `low`, `off`        |
| `{identity.name}` | 에이전트 신원 이름 | (`"auto"`와 동일)           |

변수는 대소문자를 구분하지 않습니다. `{think}`는 `{thinkingLevel}`의 별칭입니다.

### Ack 반응

- 기본값은 활성 에이전트의 `identity.emoji`이고, 그렇지 않으면 `"👀"`입니다. 비활성화하려면 `""`를 설정하세요.
- 범위: `group-mentions` (기본값), `group-all`, `direct`, `all`.
- `removeAckAfterReply`: 응답 후 확인을 제거합니다(Slack/Discord/Telegram/Google Chat만 해당).

### 인바운드 디바운스

동일한 발신자가 보낸 빠른 텍스트 전용 메시지를 단일 에이전트 차례로 일괄 처리합니다. 미디어/첨부 파일은 즉시 플러시됩니다. 제어 명령은 디바운싱을 우회합니다.

### TTS(텍스트 음성 변환)

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: { enabled: true },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

- `auto`는 자동 TTS를 제어합니다. `/tts off|always|inbound|tagged`는 세션별로 재정의됩니다.
- `summaryModel`는 자동 요약을 위해 `agents.defaults.model.primary`를 무시합니다.
- API 키는 `ELEVENLABS_API_KEY`/`XI_API_KEY` 및 `OPENAI_API_KEY`로 대체됩니다.

---

## 토크

토크 모드(macOS/iOS/Android)의 기본값입니다.

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

- 음성 ID는 `ELEVENLABS_VOICE_ID` 또는 `SAG_VOICE_ID`로 대체됩니다.
- `apiKey`는 `ELEVENLABS_API_KEY`로 대체됩니다.
- `voiceAliases` Talk 지시문에 친숙한 이름을 사용할 수 있습니다.

---

## 도구

### 도구 프로필

`tools.profile`는 `tools.allow`/`tools.deny` 이전에 기본 허용 목록을 설정합니다.

| 프로필      | 포함                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` 전용                                                                     |
| `coding`    | `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`                    |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status` |
| `full`      | 제한 없음(설정되지 않은 것과 동일)                                                        |

### 도구 그룹

| 그룹               | 도구                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`, `process` (`bash`는 `exec`)의 별칭으로 허용됩니다.                               |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                   |
| `group:sessions`   | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` |
| `group:memory`     | `memory_search`, `memory_get`                                                            |
| `group:web`        | `web_search`, `web_fetch`                                                                |
| `group:ui`         | `browser`, `canvas`                                                                      |
| `group:automation` | `cron`, `gateway`                                                                        |
| `group:messaging`  | `message`                                                                                |
| `group:nodes`      | `nodes`                                                                                  |
| `group:openclaw`   | 모든 내장 도구(공급자 플러그인 제외)                                                     |

### `tools.allow` / `tools.deny`

전역 도구 허용/거부 정책(거부 승리). 대소문자를 구분하지 않으며 `*` 와일드카드를 지원합니다. Docker sandbox가 꺼져 있는 경우에도 적용됩니다.

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

### `tools.byProvider`

특정 공급자 또는 모델에 대한 도구를 추가로 제한합니다. 순서: 기본 프로필 → 공급자 프로필 → 허용/거부.

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

### `tools.elevated`

승격된(호스트) exec 액세스를 제어합니다.

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

- 에이전트별 재정의(`agents.list[].tools.elevated`)는 추가 제한만 가능합니다.
- `/elevated on|off|ask|full`는 세션당 상태를 저장합니다. 인라인 지시어는 단일 메시지에 적용됩니다.
- 상승된 `exec`는 호스트에서 실행되며 샌드박싱을 우회합니다.

### `tools.exec`

```json5
{
  tools: {
    exec: {
      backgroundMs: 10000,
      timeoutSec: 1800,
      cleanupMs: 1800000,
      notifyOnExit: true,
      applyPatch: {
        enabled: false,
        allowModels: ["gpt-5.2"],
      },
    },
  },
}
```

### `tools.web`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "brave_api_key", // or BRAVE_API_KEY env
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        userAgent: "custom-ua",
      },
    },
  },
}
```

### `tools.media`

인바운드 미디어 이해(이미지/오디오/비디오)를 구성합니다.

```json5
{
  tools: {
    media: {
      concurrency: 2,
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

<Accordion title="Media model entry fields">

    **공급자 항목** (`type: "provider"` 또는 생략):

    - `provider`: API 제공자 ID (`openai`, `anthropic`, `google`/`gemini`, `groq` 등)
    - `model`: 모델 ID 재정의
    - `profile` / `preferredProfile`: 인증 프로필 선택

    **CLI 항목** (`type: "cli"`):

    - `command` : 실행 가능한 실행 파일
    - `args`: 템플릿 인수(`{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}` 등 지원)

    **공통 필드:**

    - `capabilities`: 선택적 목록(`image`, `audio`, `video`). 기본값: `openai`/`anthropic`/`minimax` → 이미지, `google` → 이미지+오디오+비디오, `groq` → 오디오.
    - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`: 항목별로 재정의됩니다.
    - 실패하면 다음 항목으로 돌아갑니다.

    공급자 인증은 인증 프로필 → 환경 변수 → `models.providers.*.apiKey`의 표준 순서를 따릅니다.

</Accordion>

### `tools.agentToAgent`

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `tools.subagents`

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
    },
  },
}
```

- `model`: 생성된 하위 에이전트의 기본 모델입니다. 생략하면 하위 에이전트가 호출자의 모델을 상속합니다.
- 하위 에이전트별 도구 정책: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`.

---

## 사용자 정의 공급자 및 기본 URL

OpenClaw는 pi-coding-agent 모델 카탈로그를 사용합니다. 구성의 `models.providers` 또는 `~/.openclaw/agents/<agentId>/agent/models.json`를 통해 사용자 정의 공급자를 추가합니다.

```json5
{
  models: {
    mode: "merge", // merge (default) | replace
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions", // openai-completions | openai-responses | anthropic-messages | google-generative-ai
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

- 사용자 정의 인증이 필요한 경우 `authHeader: true` + `headers`를 사용하세요.
- 에이전트 구성 루트를 `OPENCLAW_AGENT_DIR`(또는 `PI_CODING_AGENT_DIR`)로 재정의합니다.

### 제공자 예

<Accordion title="Cerebras (GLM 4.6 / 4.7)">

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

대뇌에는 `cerebras/zai-glm-4.7`를 사용하세요. `zai/glm-4.7` Z.AI 직접용.

</Accordion>

<Accordion title="OpenCode Zen">

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

`OPENCODE_API_KEY`(또는 `OPENCODE_ZEN_API_KEY`)를 설정합니다. 단축키: `openclaw onboard --auth-choice opencode-zen`.

</Accordion>

<Accordion title="Z.AI (GLM-4.7)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

`ZAI_API_KEY`를 설정합니다. `z.ai/*` 및 `z-ai/*`는 허용되는 별칭입니다. 단축키: `openclaw onboard --auth-choice zai-api-key`.

    - 일반 엔드포인트: `https://api.z.ai/api/paas/v4`
    - 코딩 끝점(기본값): `https://api.z.ai/api/coding/paas/v4`
    - 일반 엔드포인트의 경우 기본 URL 재정의를 사용하여 사용자 지정 공급자를 정의합니다.

</Accordion>

<Accordion title="Moonshot AI (Kimi)">

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

중국 엔드포인트의 경우: `baseUrl: "https://api.moonshot.cn/v1"` 또는 `openclaw onboard --auth-choice moonshot-api-key-cn`.

</Accordion>

<Accordion title="Kimi Coding">

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

인류와 호환되는 내장형 공급자입니다. 단축키: `openclaw onboard --auth-choice kimi-code-api-key`.

</Accordion>

<Accordion title="Synthetic (Anthropic-compatible)">

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

기본 URL은 `/v1`를 생략해야 합니다(Anthropic 클라이언트가 이를 추가합니다). 단축키: `openclaw onboard --auth-choice synthetic-api-key`.

</Accordion>

<Accordion title="MiniMax M2.1 (direct)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

`MINIMAX_API_KEY`를 설정합니다. 단축키: `openclaw onboard --auth-choice minimax-api`.

</Accordion>

<Accordion title="Local models (LM Studio)">

[로컬 모델](/gateway/local-models)을 참조하세요. 핵심요약: 심각한 하드웨어에서 LM Studio Responses API를 통해 MiniMax M2.1을 실행하세요. 대체를 위해 호스팅된 모델을 병합된 상태로 유지합니다.

</Accordion>

---

## 스킬

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

- `allowBundled`: 번들 기술에 대해서만 선택적 허용 목록입니다(관리/작업 공간 기술은 영향을 받지 않음).
- `entries.<skillKey>.enabled: false`는 번들/설치되어 있어도 스킬을 비활성화합니다.
- `entries.<skillKey>.apiKey`: 기본 환경 변수를 선언하는 스킬의 편의성입니다.

---

## 플러그인

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: [],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        config: { provider: "twilio" },
      },
    },
  },
}
```

- `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions` 및 `plugins.load.paths`에서 로드됩니다.
- **구성을 변경하려면 게이트웨이를 다시 시작해야 합니다.**
- `allow`: 선택적 허용 목록(목록에 있는 플러그인만 로드). `deny`가 승리합니다.

[플러그인](/tools/plugin)을 참조하세요.

---

## 브라우저

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    defaultProfile: "chrome",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false,
  },
}
```

- `evaluateEnabled: false`는 `act:evaluate`와 `wait --fn`를 비활성화합니다.
- 원격 프로필은 연결 전용입니다(시작/중지/재설정이 비활성화됨).
- 자동 감지 순서: Chromium 기반 → Chrome → Brave → Edge → Chromium → Chrome Canary인 경우 기본 브라우저입니다.
- 제어 서비스: 루프백 전용(`gateway.port`에서 파생된 포트, 기본값 `18791`).

---

## UI

```json5
{
  ui: {
    seamColor: "#FF4500",
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, image URL, or data URI
    },
  },
}
```

- `seamColor`: 기본 앱 UI 크롬의 강조 색상(토크 모드 풍선 색조 등).
- `assistant`: UI ID 재정의를 제어합니다. 활성 상담원 ID로 대체됩니다.

---

## 게이트웨이

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    auth: {
      mode: "token", // token | password
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
      allowTailscale: true,
    },
    tailscale: {
      mode: "off", // off | serve | funnel
      resetOnExit: false,
    },
    controlUi: {
      enabled: true,
      basePath: "/openclaw",
      // root: "dist/control-ui",
      // allowInsecureAuth: false,
      // dangerouslyDisableDeviceAuth: false,
    },
    remote: {
      url: "ws://gateway.tailnet:18789",
      transport: "ssh", // ssh | direct
      token: "your-token",
      // password: "your-password",
    },
    trustedProxies: ["10.0.0.1"],
  },
}
```

<Accordion title="Gateway field details">

    - `mode`: `local` (게이트웨이 실행) 또는 `remote` (원격 게이트웨이에 연결). `local`이 아니면 게이트웨이가 시작을 거부합니다.
    - `port`: WS + HTTP용 단일 다중화 포트입니다. 우선순위: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > `18789`.
    - `bind`: `auto`, `loopback` (기본값), `lan` (`0.0.0.0`), `tailnet` (Tailscale IP 전용) 또는 `custom`.
    - **인증**: 기본적으로 필요합니다. 비루프백 바인딩에는 공유 토큰/비밀번호가 필요합니다. 온보딩 마법사는 기본적으로 토큰을 생성합니다.
    - `auth.allowTailscale`: `true`일 때 Tailscale Serve ID 헤더가 인증을 충족합니다(`tailscale whois`를 통해 확인됨). `tailscale.mode = "serve"`일 때 기본값은 `true`입니다.
    - `tailscale.mode`: `serve`(테일넷 전용, 루프백 바인드) 또는 `funnel`(공개, 인증 필요).
    - `remote.transport`: `ssh` (기본값) 또는 `direct` (ws/wss). `direct`의 경우 `remote.url`는 `ws://` 또는 `wss://`여야 합니다.
    - `gateway.remote.token`는 원격 CLI 호출 전용입니다. 로컬 게이트웨이 인증을 활성화하지 않습니다.
    - `trustedProxies` : TLS를 종료하는 역방향 프록시 IP. 귀하가 제어하는 ​​프록시만 나열하십시오.

</Accordion>

### OpenAI 호환 엔드포인트

- 채팅 완료: 기본적으로 비활성화되어 있습니다. `gateway.http.endpoints.chatCompletions.enabled: true`로 활성화하세요.
- 응답 API: `gateway.http.endpoints.responses.enabled`.
- 응답 URL 입력 강화:
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`

### 다중 인스턴스 격리

고유한 포트와 상태 디렉터리를 사용하여 하나의 호스트에서 여러 게이트웨이를 실행합니다.

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

편의 플래그: `--dev` (`~/.openclaw-dev` + 포트 `19001` 사용), `--profile <name>` (`~/.openclaw-<name>` 사용))

[다중 게이트웨이](/gateway/multiple-gateways)를 참조하세요.

---

## 후크

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    maxBodyBytes: 262144,
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
    allowedAgentIds: ["hooks", "main"],
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        agentId: "hooks",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

인증: `Authorization: Bearer <token>` 또는 `x-openclaw-token: <token>`.

**엔드포인트:**

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, agentId?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
  - 요청 페이로드의 `sessionKey`는 `hooks.allowRequestSessionKey=true`인 경우에만 허용됩니다(기본값: `false`).
- `POST /hooks/<name>` → `hooks.mappings`를 통해 해결됨

<Accordion title="Mapping details">

    - `match.path`는 `/hooks` 뒤의 하위 경로와 일치합니다(예: `/hooks/gmail` → `gmail`).
    - `match.source`는 일반 경로의 페이로드 필드와 일치합니다.
    - `{{messages[0].subject}}`와 같은 템플릿은 페이로드에서 읽습니다.
    - `transform`는 후크 작업을 반환하는 JS/TS 모듈을 가리킬 수 있습니다.
    - `agentId`는 특정 에이전트에게 라우팅됩니다. 알 수 없는 ID는 기본값으로 돌아갑니다.
    - `allowedAgentIds`: 명시적 라우팅을 제한합니다(`*` 또는 생략 = 모두 허용, `[]` = 모두 거부).
    - `defaultSessionKey`: 후크 에이전트에 대한 선택적 고정 세션 키가 명시적인 `sessionKey` 없이 실행됩니다.
    - `allowRequestSessionKey`: `/hooks/agent` 호출자가 `sessionKey`를 설정하도록 허용합니다(기본값: `false`).
    - `allowedSessionKeyPrefixes`: 명시적인 `sessionKey` 값(요청 + 매핑)에 대한 선택적 접두사 허용 목록입니다. `["hook:"]`.
    - `deliver: true`는 채널에 최종 응답을 보냅니다. `channel`의 기본값은 `last`입니다.
    - `model`는 이 후크 실행에 대한 LLM을 재정의합니다(모델 카탈로그가 설정된 경우 허용되어야 함).

</Accordion>

### Gmail 통합

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

- 게이트웨이가 구성되면 부팅 시 `gog gmail watch serve`가 자동 시작됩니다. 비활성화하려면 `OPENCLAW_SKIP_GMAIL_WATCHER=1`를 설정하세요.
- 게이트웨이와 함께 별도의 `gog gmail watch serve`를 실행하지 마십시오.

---

## 캔버스 호스트

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
    // enabled: false, // or OPENCLAW_SKIP_CANVAS_HOST=1
  },
}
```

- iOS/Android 노드에 대해 HTTP를 통해 HTML/CSS/JS를 제공합니다.
- 라이브 다시 로드 클라이언트를 제공된 HTML에 삽입합니다.
- 비어 있으면 스타터 `index.html`를 자동 생성합니다.
- `/__openclaw__/a2ui/`에서도 A2UI를 제공합니다.
- 변경사항을 적용하려면 게이트웨이를 다시 시작해야 합니다.
- 대규모 디렉터리 또는 `EMFILE` 오류에 대한 라이브 다시 로드를 비활성화합니다.

---

## 발견

### mDNS(봉쥬르)

```json5
{
  discovery: {
    mdns: {
      mode: "minimal", // minimal | full | off
    },
  },
}
```

- `minimal` (기본값): TXT 레코드에서 `cliPath` + `sshPort`를 생략합니다.
- `full`: `cliPath` + `sshPort`를 포함합니다.
- 호스트 이름은 기본적으로 `openclaw`입니다. `OPENCLAW_MDNS_HOSTNAME`로 재정의합니다.

### 광역(DNS-SD)

```json5
{
  discovery: {
    wideArea: { enabled: true },
  },
}
```

`~/.openclaw/dns/` 아래에 유니캐스트 DNS-SD 영역을 씁니다. 교차 네트워크 검색의 경우 DNS 서버(CoreDNS 권장) + Tailscale 분할 DNS와 페어링합니다.

설정: `openclaw dns setup --apply`.

---

## 환경

### `env` (인라인 환경 변수)

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

- 인라인 환경 변수는 프로세스 환경에 키가 누락된 경우에만 적용됩니다.
- `.env` 파일: CWD `.env` + `~/.openclaw/.env` (기존 변수를 재정의하지 않음).
- `shellEnv`: 로그인 셸 프로필에서 누락된 예상 키를 가져옵니다.
- 전체 우선순위는 [환경](/help/environment)을 참조하세요.

### 환경 변수 대체

`${VAR_NAME}`를 사용하여 모든 구성 문자열에서 환경 변수를 참조하세요.

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- 대문자만 일치합니다: `[A-Z_][A-Z0-9_]*`.
- 구성 로드 시 누락/빈 변수가 오류를 발생시킵니다.
- 리터럴 `${VAR}`에 대해 `$${VAR}`로 탈출합니다.
- `$include`와 함께 작동합니다.

---

## 인증 저장

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

- 에이전트별 인증 프로필은 `<agentDir>/auth-profiles.json`에 저장됩니다.
- 레거시 OAuth는 `~/.openclaw/credentials/oauth.json`에서 가져옵니다.
- [OAuth](/concepts/oauth)를 참조하세요.

---

## 로깅

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty", // pretty | compact | json
    redactSensitive: "tools", // off | tools
    redactPatterns: ["\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1"],
  },
}
```

- 기본 로그 파일 : `/tmp/openclaw/openclaw-YYYY-MM-DD.log`.
- 안정적인 경로를 위해 `logging.file`를 설정하세요.
- `consoleLevel`는 `--verbose`일 때 `debug`와 충돌합니다.

---

## 마법사

CLI 마법사가 작성한 메타데이터(`onboard`, `configure`, `doctor`):

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

---

## 아이덴티티

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

macOS 온보딩 어시스턴트가 작성했습니다. 기본값 파생:

- `messages.ackReaction` from `identity.emoji` ( 다시 GW로 돌아감)
- `mentionPatterns` from `identity.name`/`identity.emoji`
- `avatar`는 작업공간 상대 경로, `http(s)` URL 또는 `data:` URI를 허용합니다.

---

## 브리지(레거시, 제거됨)

현재 빌드에는 더 이상 TCP 브리지가 포함되지 않습니다. 노드는 Gateway WebSocket을 통해 연결됩니다. `bridge.*` 키는 더 이상 구성 스키마의 일부가 아닙니다(제거될 때까지 검증이 실패합니다. `openclaw doctor --fix`는 알 수 없는 키를 제거할 수 있습니다).

<Accordion title="Legacy bridge config (historical reference)">

```json
{
  "bridge": {
    "enabled": true,
    "port": 18790,
    "bind": "tailnet",
    "tls": {
      "enabled": true,
      "autoGenerate": true
    }
  }
}
```

</Accordion>

---

## 크론

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
    sessionRetention: "24h", // duration string or false
  },
}
```

- `sessionRetention`: 가지치기 전에 완료된 크론 세션을 유지하는 기간입니다. 기본값: `24h`.

[Cron 작업](/automation/cron-jobs)을 참조하세요.

---

## 미디어 모델 템플릿 변수

`tools.media.*.models[].args`에서 확장된 템플릿 자리 표시자:

| 변수               | 설명                                         |
| ------------------ | -------------------------------------------- |
| `{{Body}}`         | 전체 인바운드 메시지 본문                    |
| `{{RawBody}}`      | 원시 본문(기록/발신자 래퍼 없음)             |
| `{{BodyStripped}}` | 그룹 언급이 제거된 본문                      |
| `{{From}}`         | 발신자 식별자                                |
| `{{To}}`           | 목적지 식별자                                |
| `{{MessageSid}}`   | 채널 메시지 ID                               |
| `{{SessionId}}`    | 현재 세션 UUID                               |
| `{{IsNewSession}}` | `"true"` 새 세션이 생성될 때                 |
| `{{MediaUrl}}`     | 인바운드 미디어 의사 URL                     |
| `{{MediaPath}}`    | 로컬 미디어 경로                             |
| `{{MediaType}}`    | 미디어 유형(이미지/오디오/문서/…)            |
| `{{Transcript}}`   | 오디오 대본                                  |
| `{{Prompt}}`       | CLI 항목에 대한 해결된 미디어 프롬프트       |
| `{{MaxChars}}`     | CLI 항목에 대한 최대 출력 문자 해결          |
| `{{ChatType}}`     | `"direct"` 또는 `"group"`                    |
| `{{GroupSubject}}` | 그룹 주제(최선의 노력)                       |
| `{{GroupMembers}}` | 그룹 구성원 미리보기(최선의 노력)            |
| `{{SenderName}}`   | 보낸 사람 표시 이름(최선의 노력)             |
| `{{SenderE164}}`   | 발신자 전화번호(최선의 노력)                 |
| `{{Provider}}`     | 공급자 힌트(whatsapp, 텔레그램, 디스코드 등) |

---

## 구성 포함 (`$include`)

구성을 여러 파일로 분할합니다.

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

**병합 동작:**

- 단일 파일: 포함된 객체를 대체합니다.
- 파일 배열: 순서대로 심층 병합됩니다(나중에 이전보다 우선 적용됨).
- 형제 키: 포함 후 병합됩니다(포함된 값 재정의).
- 중첩에는 최대 10레벨까지 포함됩니다.
- 경로: 상대(포함 파일에 대한), 절대 또는 `../` 상위 참조.
- 오류: 누락된 파일, 구문 분석 오류 및 순환 포함에 대한 메시지를 지웁니다.

---

_관련: [구성](/gateway/configuration) · [구성 예](/gateway/configuration-examples) · [닥터](/gateway/doctor)_
