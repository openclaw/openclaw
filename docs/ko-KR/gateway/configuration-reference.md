---
title: "구성 참조"
description: "완전한 필드별 참조를 위한 ~/.openclaw/openclaw.json"
---

# 구성 참조

`~/.openclaw/openclaw.json` 에서 사용할 수 있는 모든 필드. 작업 지향 개요는 [구성](/ko-KR/gateway/configuration) 을 참조하세요.

구성 형식은 **JSON5** (주석 + 후행 쉼표 허용) 입니다. 모든 필드는 선택 사항입니다 — OpenClaw 는 생략 시 안전한 기본값을 사용합니다.

---

## 채널

각 채널은 구성 섹션이 존재할 때 자동으로 시작됩니다 (`enabled: false` 인 경우 제외).

### 다이렉트 메시지와 그룹 접근

모든 채널은 다이렉트 메시지 정책과 그룹 정책을 지원합니다:

| 다이렉트 메시지 정책 | 동작                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| `pairing` (기본값)   | 알 수 없는 발신자는 일회성 페어링 코드를 받으며 소유자가 승인해야 합니다 |
| `allowlist`          | `allowFrom` (또는 페어링된 allow 저장소)의 발신자만 허용                 |
| `open`               | 모든 수신 다이렉트 메시지를 허용 ( `allowFrom: ["*"]` 필요)              |
| `disabled`           | 모든 수신 다이렉트 메시지 무시                                           |

| 그룹 정책            | 동작                                                |
| -------------------- | --------------------------------------------------- |
| `allowlist` (기본값) | 구성된 허용 목록과 일치하는 그룹에만 허용           |
| `open`               | 그룹 허용 목록을 우회 (언급 게이팅은 여전히 적용됨) |
| `disabled`           | 모든 그룹/방 메시지 차단                            |

<Note>
`channels.defaults.groupPolicy` 는 프로바이더의 `groupPolicy` 가 설정되지 않았을 때 기본값을 설정합니다. 페어링 코드는 1 시간 후 만료됩니다. 대기 중인 다이렉트 메시지 페어링 요청은 **채널 당 3 개** 로 제한됩니다. Slack/Discord 는 특별한 예외 사항을 가지고 있습니다: 프로바이더 섹션이 완전히 없을 경우 런타임 그룹 정책은 `open` 으로 해결될 수 있습니다 (시작 경고와 함께).
</Note>

### WhatsApp

WhatsApp 은 게이트웨이의 웹 채널 (Baileys Web) 을 통해 실행됩니다. 연결된 세션이 존재할 때 자동으로 시작됩니다.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000,
      chunkMode: "length", // length | newline
      mediaMaxMb: 50,
      sendReadReceipts: true, // 파란색 체크 (자체 대화 모드에서는 false)
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

<Accordion title="다중 계정 WhatsApp">

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

- 아웃바운드 명령어는 `default` 계정으로 기본 설정됩니다. 없을 경우, 첫 번째로 설정된 계정 ID 로 설정됩니다 (정렬된 상태).
- 기존 단일 계정 Baileys 인증 디렉토리는 `openclaw doctor` 에 의해 `whatsapp/default` 로 마이그레이션됩니다.
- 계정별 재정의: `channels.whatsapp.accounts.<id>.sendReadReceipts`, `channels.whatsapp.accounts.<id>.dmPolicy`, `channels.whatsapp.accounts.<id>.allowFrom`.

</Accordion>

### Telegram

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
          systemPrompt: "짧게 대답하세요.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "주제에 집중하세요.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git 백업" },
        { command: "generate", description: "이미지 생성" },
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

- 봇 토큰: `channels.telegram.botToken` 또는 `channels.telegram.tokenFile`, 기본 계정의 경우 `TELEGRAM_BOT_TOKEN` 으로 대체합니다.
- `configWrites: false` 는 Telegram 이 시작한 구성 쓰기를 차단합니다 (슈퍼그룹 ID 마이그레이션, `/config set|unset`).
- Telegram 스트림 미리보기는 `sendMessage` + `editMessageText` 사용 (다이렉트 및 그룹 채팅에서 작동).
- 재시도 정책: [Retry policy](/ko-KR/concepts/retry) 를 참조하세요.

### Discord

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
      dmPolicy: "pairing",
      allowFrom: ["1234567890", "steipete"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["openclaw-dm"] },
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
              systemPrompt: "짧게 대답하세요.",
            },
          },
        },
      },
      historyLimit: 20,
      textChunkLimit: 2000,
      chunkMode: "length", // length | newline
      maxLinesPerMessage: 17,
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
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

- 토큰: `channels.discord.token`, 기본 계정의 경우 `DISCORD_BOT_TOKEN` 으로 대체합니다.
- 배송 대상에는 `user:<id>` (다이렉트 메시지) 또는 `channel:<id>` (길드 채널) 을 사용합니다. 숫자 ID 는 거부됩니다.
- 길드 슬러그는 소문자며, 공백은 `-` 로 대체합니다. 채널 키에는 슬러그 이름을 사용하여 `#` 을 포함하지 마세요. 길드 ID 를 선호하세요.
- 봇이 작성한 메시지는 기본적으로 무시됩니다. `allowBots: true` 를 통해 활성화할 수 있습니다 (여전히 자신이 보낸 메시지는 필터링됨).
- `maxLinesPerMessage` (기본값 17)는 2000자 미만의 긴 메시지라도 분할합니다.
- `channels.discord.ui.components.accentColor` 는 Discord 컴포넌트 v2 컨테이너의 강조 색상을 설정합니다.

**반응 알림 모드:** `off` (없음), `own` (봇의 메시지, 기본값), `all` (모든 메시지), `allowlist` (모든 메시지의 `guilds.<id>.users` 에서).

### Google Chat

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

- 서비스 계정 JSON: 인라인 (`serviceAccount`) 또는 파일 기반 (`serviceAccountFile`).
- 환경 대체: `GOOGLE_CHAT_SERVICE_ACCOUNT` 또는 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- 배송 대상에는 `spaces/<spaceId>` 또는 `users/<userId|email>` 을 사용합니다.

### Slack

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dmPolicy: "pairing",
      allowFrom: ["U123", "U456", "*"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["G123"] },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "짧게 대답하세요.",
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

- **소켓 모드**는 `botToken` 과 `appToken` 이 모두 필요합니다 (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` 은 기본 계정의 환경 대체).
- **HTTP 모드**는 `botToken` 과 `signingSecret` 이 필요합니다 (루트 또는 계정별).
- `configWrites: false` 는 Slack 이 시작한 구성 쓰기를 차단합니다.
- 배송 대상에는 `user:<id>` (다이렉트 메시지) 또는 `channel:<id>` 를 사용합니다.

**반응 알림 모드:** `off`, `own` (기본값), `all`, `allowlist` ( `reactionAllowlist` 에서).

**스레드 세션 격리:** `thread.historyScope` 는 스레드별 (기본값) 이거나 채널 전체 공유일 수 있습니다. `thread.inheritParent` 는 부모 채널의 대화를 새로운 스레드로 복사합니다.

| 동작 그룹  | 기본값 | 비고                    |
| ---------- | ------ | ----------------------- |
| reactions  | 활성화 | 반응 추가 및 목록 표시  |
| messages   | 활성화 | 읽기/발송/편집/삭제     |
| pins       | 활성화 | 고정/해제/목록          |
| memberInfo | 활성화 | 회원 정보               |
| emojiList  | 활성화 | 사용자 정의 이모지 목록 |

### Mattermost

Mattermost 는 플러그인으로 제공됩니다: `openclaw plugins install @openclaw/mattermost`.

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

채팅 모드: `oncall` (언급 시 응답, 기본값), `onmessage` (모든 메시지), `onchar` (트리거 접두사로 시작하는 메시지).

### Signal

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

**반응 알림 모드:** `off`, `own` (기본값), `all`, `allowlist` ( `reactionAllowlist` 에서).

### iMessage

OpenClaw 는 `imsg rpc` (stdio 를 통한 JSON-RPC) 를 생성합니다. 데몬 또는 포트가 필요하지 않습니다.

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
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

- 메시지 DB 에 대한 전체 디스크 접근 권한이 필요합니다.
- `chat_id:<id>` 대상을 선호합니다. `imsg chats --limit 20` 을 사용하여 채팅 목록을 확인하세요.
- `cliPath` 는 SSH 래퍼를 가리킬 수 있으며, SCP 첨부 파일 수집을 위해 `remoteHost` (`host` 또는 `user@host`)를 설정하십시오.
- `attachmentRoots` 및 `remoteAttachmentRoots`는 인바운드 첨부 파일 경로를 제한합니다 (기본값: `/Users/*/Library/Messages/Attachments`).
- SCP는 엄격한 호스트 키 검사를 사용하므로 릴레이 호스트 키가 `~/.ssh/known_hosts`에 이미 있어야 합니다.

<Accordion title="iMessage SSH 래퍼 예제">

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

</Accordion>

### 다중 계정 (모든 채널)

채널별로 여러 계정을 실행합니다 (각각 자체 `accountId` 포함):

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "주요 봇",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "경고 봇",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

- `default` 는 `accountId` 가 생략된 경우에 사용됩니다 (CLI + 라우팅).
- 환경 토큰은 **기본** 계정에만 적용됩니다.
- 기본 채널 설정은 모든 계정에 적용되며, 계정별로 재정의 할 수 있습니다.
- 각 에이전트에 다른 계정을 라우팅하려면 `bindings[].match.accountId` 를 사용하십시오.

### 그룹 채팅 언급 게이팅

그룹 메시지는 기본적으로 **언급 필요** (메타데이터 언급 또는 정규 표현식 패턴) 입니다. 이는 WhatsApp, Telegram, Discord, Google Chat 및 iMessage 그룹 채팅에 적용됩니다.

**언급 유형:**

- **메타데이터 언급**: 플랫폼 네이티브 @-언급. WhatsApp 자체 대화 모드에서는 무시됩니다.
- **텍스트 패턴**: `agents.list[].groupChat.mentionPatterns` 에서 정규 표현식 패턴. 항상 확인됩니다.
- 탐지가 가능한 경우에만 언급 게이팅이 적용됩니다 (네이티브 언급 또는 최소한 하나의 패턴).

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

`messages.groupChat.historyLimit` 는 글로벌 기본값을 설정합니다. 채널은 `channels.<channel>.historyLimit` (또는 계정별) 로 재정의 할 수 있습니다. `0` 으로 설정하여 비활성화할 수 있습니다.

#### 다이렉트 메시지 기록 제한

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

해결 순서: 다이렉트 메시지 재정의 → 프로바이더 기본값 → 무제한 (모두 보존)

지원됨: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

#### 자체 대화 모드

자체 대화 모드를 활성화하려면 자신의 번호를 `allowFrom` 에 포함합니다 (네이티브 @-언급을 무시하고, 텍스트 패턴에만 응답합니다):

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

### 명령어 (채팅 명령어 처리)

```json5
{
  commands: {
    native: "auto", // 지원 시 네이티브 명령어 등록
    text: true, // 채팅 메시지에서 /명령어 해석
    bash: false, // ! 허용 (/bash 별칭)
    bashForegroundMs: 2000,
    config: false, // /config 허용
    debug: false, // /debug 허용
    restart: false, // /restart + 게이트웨이 재시작 도구 허용
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

<Accordion title="명령어 세부사항">

- 텍스트 명령어는 앞에 `/` 가 있는 **단독** 메시지여야 합니다.
- `native: "auto"` 는 Discord/Telegram 에 네이티브 명령어를 활성화하며, Slack 은 비활성화 상태로 둡니다.
- 채널별로 재정의: `channels.discord.commands.native` (bool 또는 `"auto"`). `false` 는 이전에 등록된 명령어를 모두 지웁니다.
- `channels.telegram.customCommands` 는 추가적인 Telegram 봇 메뉴 항목을 추가합니다.
- `bash: true` 는 호스트 셸에서 `! <cmd>` 를 활성화합니다. `tools.elevated.enabled` 와 발신자가 `tools.elevated.allowFrom.<channel>` 에 있어야 합니다.
- `config: true` 는 `/config` 를 활성화합니다 ( `openclaw.json` 을 읽고 쓰기).
- `channels.<provider>.configWrites` 는 채널 별로 구성 변경을 허용합니다 (기본값: true).
- `allowFrom` 는 프로바이더별로 적용됩니다. 설정된 경우, 이는 **유일한** 권한 출처이며, 채널 허용 목록/페어링 및 `useAccessGroups` 는 무시됩니다.
- `useAccessGroups: false` 는 명령어가 `allowFrom` 이 설정되지 않은 경우 접근 그룹 정책을 우회할 수 있도록 합니다.

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

시스템 프롬프트의 런타임 라인에 표시되는 선택적 리포지토리 루트. 설정되지 않으면 OpenClaw는 워크스페이스에서 위로 탐색하여 자동 감지합니다.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

워크스페이스 부트스트랩 파일 (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) 의 자동 생성을 비활성화합니다.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

워크스페이스 부트스트랩 파일마다 잘리기 전 최대 문자 수입니다. 기본값: `20000`.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.bootstrapTotalMaxChars`

모든 워크스페이스 부트스트랩 파일에 주입되는 최대 총 문자 수입니다. 기본값: `150000`.

```json5
{
  agents: { defaults: { bootstrapTotalMaxChars: 150000 } },
}
```

### `agents.defaults.imageMaxDimensionPx`

프로바이더 호출 전 트랜스크립트/도구 이미지 블록에서 가장 긴 이미지 측면의 최대 픽셀 크기입니다.
기본값: `1200`.

값이 낮을수록 일반적으로 스크린샷이 많은 실행에서 비전 토큰 사용량과 요청 페이로드 크기가 줄어듭니다.
값이 높을수록 더 많은 시각적 세부 정보가 보존됩니다.

```json5
{
  agents: { defaults: { imageMaxDimensionPx: 1200 } },
}
```

### `agents.defaults.userTimezone`

시스템 프롬프트 컨텍스트용 시간대 (메시지 타임스탬프가 아님). 호스트 시간대로 대체됩니다.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

시스템 프롬프트의 시간 형식입니다. 기본값: `auto` (OS 선호도).

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

- `model.primary`: 형식 `provider/model` (예: `anthropic/claude-opus-4-6`). 프로바이더를 생략한 경우, OpenClaw 는 `anthropic` 으로 가정합니다 (사용 중단됨).
- `models`: 구성된 모델 카탈로그 및 `/model` 에 대한 허용 목록. 각 항목에는 `alias` (단축키) 및 `params` (프로바이더별: `temperature`, `maxTokens`) 를 포함할 수 있습니다.
- `imageModel`: 기본 모델에 이미지 입력이 없는 경우에만 사용됩니다.
- `maxConcurrent`: 세션 간에 최대 병렬 에이전트 실행을 설정합니다 (각 세션은 여전히 직렬화됩니다). 기본값: 1.

**내장된 별칭 단축키** (모델이 `agents.defaults.models` 에 있는 경우에만 적용):

| 별칭           | 모델                            |
| -------------- | ------------------------------- |
| `opus`         | `anthropic/claude-opus-4-6`     |
| `sonnet`       | `anthropic/claude-sonnet-4-5`   |
| `gpt`          | `openai/gpt-5.2`                |
| `gpt-mini`     | `openai/gpt-5-mini`             |
| `gemini`       | `google/gemini-3-pro-preview`   |
| `gemini-flash` | `google/gemini-3-flash-preview` |

구성된 별칭이 항상 기본값을 이깁니다.

Z.AI GLM-4.x 모델은 `--thinking off` 를 설정하거나 `agents.defaults.models["zai/<model>"].params.thinking` 를 정의하지 않는 한 자동으로 사고 모드를 활성화합니다.
Z.AI 모델은 도구 호출 스트리밍을 위해 기본적으로 `tool_stream` 을 활성화합니다. 비활성화하려면 `agents.defaults.models["zai/<model>"].params.tool_stream` 을 `false` 로 설정하세요.

### `agents.defaults.cliBackends`

텍스트 전용 대체 실행을 위한 선택적 CLI 백엔드 (도구 호출 없음). API 프로바이더가 실패할 때 백업으로 유용합니다.

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

- CLI 백엔드는 텍스트 우선이며, 도구는 항상 비활성화됩니다.
- `sessionArg` 가 설정된 경우 세션이 지원됩니다.
- `imageArg` 가 파일 경로를 허용하는 경우 이미지 전달이 지원됩니다.

### `agents.defaults.heartbeat`

주기적인 하트비트 실행.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 0m 비활성화
        model: "openai/gpt-5.2-mini",
        includeReasoning: false,
        session: "main",
        to: "+15555550123",
        target: "last", // last | whatsapp | telegram | discord | ... | none
        prompt: "HEARTBEAT.md 를 읽어보세요, 존재한다면...",
        ackMaxChars: 300,
        suppressToolErrorWarnings: false,
      },
    },
  },
}
```

- `every`: 지속시간 문자열 (ms/s/m/h). 기본값: `30m`.
- `suppressToolErrorWarnings`: true 인 경우, 하트비트 실행 중 도구 오류 경고 페이로드를 억제합니다.
- 에이전트별: `agents.list[].heartbeat` 를 설정합니다. 에이전트가 `heartbeat` 를 정의하면, **해당 에이전트만** 하트비트를 실행합니다.
- 하트비트는 전체 에이전트 턴을 실행합니다 — 짧은 간격은 더 많은 토큰을 소모합니다.

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
          systemPrompt: "세션이 압축에 가까워지고 있습니다. 내구성 있는 메모리를 지금 저장하세요.",
          prompt: "메모리/YYYY-MM-DD.md 에 영구 메모를 작성하세요; 저장할 것이 없으면 NO_REPLY 라고 답하세요.",
        },
      },
    },
  },
}
```

- `mode`: `default` 또는 `safeguard` (긴 기록을 위한 청크 요약). [Compaction](/ko-KR/concepts/compaction) 을 참조하세요.
- `memoryFlush`: 자동 압축 전에 내구성 있는 메모리를 저장하기 위한 조용한 에이전트 턴. 워크스페이스가 읽기 전용일 때 건너뜁니다.

### `agents.defaults.contextPruning`

세션의 기록을 저장하지 않고 LLM 에 보내기 전에 메모리 내 컨텍스트에서 **오래된 도구 결과**를 가지치기합니다.

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl", // off | cache-ttl
        ttl: "1h", // 지속시간 (ms/s/m/h), 기본 단위: 분
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[오래된 도구 결과 내용 삭제]" },
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

<Accordion title="cache-ttl 모드 동작">

- `mode: "cache-ttl"` 은 가지치기 패스를 활성화합니다.
- `ttl` 은 마지막 캐시 터치 이후 다음 가지치기를 얼마나 자주 실행할지 제어합니다.
- 가지치기는 먼저 크기가 큰 도구 결과를 부드럽게 트림하고, 필요시 오래된 도구 결과를 강제 삭제합니다.

**소프트 트림**은 시작과 끝을 유지하고 중간에 `...` 을 삽입합니다.

**강제 삭제**는 전체 도구 결과를 플레이스홀더로 대체합니다.

메모:

- 이미지 블록은 결코 트림/삭제되지 않습니다.
- 비율은 문자 기반 (대략), 정확한 토큰 수가 아닙니다.
- 만약 `keepLastAssistants` 내의 보조 메시지가 존재하지 않으면, 가지치기는 건너뜁니다.

</Accordion>

자세한 행동은 [Session Pruning](/ko-KR/concepts/session-pruning) 을 참조하세요.

### 블록 스트리밍

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

- Telegram 이 아닌 채널은 블록 응답을 활성화하려면 명시적인 `*.blockStreaming: true` 가 필요합니다.
- 채널 재정의: `channels.<channel>.blockStreamingCoalesce` (및 계정별 변형). Signal/Slack/Discord/Google Chat 의 기본값 `minChars: 1500` 입니다.
- `humanDelay`: 블록 응답 사이의 랜덤화된 휴지 시간. `natural` = 800–2500ms. 에이전트별 재정의: `agents.list[].humanDelay`.

자세한 행동과 청크 세부사항은 [Streaming](/ko-KR/concepts/streaming) 을 참조하세요.

### 입력 표시기

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

- 기본값: 다이렉트 채팅/언급의 경우 `instant`, 언급되지 않은 그룹 채팅의 경우 `message`.
- 세션별 재정의: `session.typingMode`, `session.typingIntervalSeconds`.

자세한 내용은 [Typing Indicators](/ko-KR/concepts/typing-indicators) 를 참조하세요.

### `agents.defaults.sandbox`

내장된 에이전트를 위한 선택적 **Docker 샌드박스 격리**. 전체 가이드는 [Sandboxing](/ko-KR/gateway/sandboxing) 을 참조하세요.

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

<Accordion title="샌드박스 세부사항">

**워크스페이스 액세스:**

- `none`: `~/.openclaw/sandboxes` 에 있는 범위에 따른 샌드박스 워크스페이스
- `ro`: 샌드박스 워크스페이스는 `/workspace` 에, 에이전트 워크스페이스는 `/agent` 에 읽기 전용으로 마운트됨
- `rw`: 에이전트 워크스페이스는 `/workspace` 에 읽기/쓰기로 마운트됨

**범위:**

- `session`: 세션당 하나의 컨테이너 및 워크스페이스
- `agent`: 에이전트당 하나의 컨테이너 및 워크스페이스 (기본값)
- `shared`: 공유된 컨테이너 및 워크스페이스 (세션 간 격리 없음)

**`setupCommand`** 는 컨테이너 생성 후 한 번 실행되며 (`sh -lc`) 네트워크 egress, 쓰기 가능한 루트, 루트 사용자가 필요합니다.

**컨테이너는 기본적으로 `network: "none"`** — 에이전트가 아웃바운드 접근이 필요하다면 `"bridge"` 로 설정하십시오.

**인바운드 첨부 파일** 은 활성 워크스페이스의 `media/inbound/*` 에 스테이징됩니다.

**`docker.binds`** 는 추가적인 호스트 디렉토리를 마운트합니다; 전역 및 에이전트별 바인드는 병합됩니다.

**샌드박스 브라우저** (`sandbox.browser.enabled`): 컨테이너 안의 Chromium + CDP. 시스템 프롬프트에 noVNC URL 삽입. 메인 구성의 `browser.enabled` 필요하지 않음.

- `allowHostControl: false` (기본값)는 샌드박스 세션이 호스트 브라우저를 대상으로 하는 것을 차단합니다.
- `sandbox.browser.binds` 는 추가적인 호스트 디렉토리를 샌드박스 브라우저 컨테이너에만 마운트합니다. 설정된 경우 ( `[]` 포함), 이는 브라우저 컨테이너에 대한 `docker.binds` 를 대체합니다.

</Accordion>

이미지 빌드:

```bash
scripts/sandbox-setup.sh           # 메인 샌드박스 이미지
scripts/sandbox-browser-setup.sh   # 선택적 브라우저 이미지
```

### `agents.list` (에이전트별 재정의)

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        name: "메인 에이전트",
        workspace: "~/.openclaw/workspace",
        agentDir: "~/.openclaw/agents/main/agent",
        model: "anthropic/claude-opus-4-6", // 또는 { primary, fallbacks }
        identity: {
          name: "Samantha",
          theme: "도움이 되는 나무늘보",
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

- `id`: 안정적인 에이전트 id (필수).
- `default`: 여러 개가 설정된 경우, 첫 번째가 적용됩니다 (경고가 기록됨). 설정되지 않은 경우, 목록의 첫 번째 항목이 기본값으로 설정됩니다.
- `model`: 문자열 형식은 `primary` 만 재정의합니다; 객체 형식 `{ primary, fallbacks }` 는 둘 다 재정의합니다 (`[]` 는 글로벌 대체를 비활성화). `primary` 만 재정의하는 Cron 작업은 `fallbacks: []` 를 설정하지 않는 한 기본 대체를 상속합니다.
- `identity.avatar`: 워크스페이스 상대 경로, `http(s)` URL 또는 `data:` URI.
- `identity`는 기본값을 유도합니다: `emoji` 에서 `ackReaction`, `name`/`emoji` 에서 `mentionPatterns`.
- `subagents.allowAgents`: `sessions_spawn` 을 위한 에이전트 id 의 허용 목록 (`["*"]` = 어떤 것이든; 기본값: 동일한 에이전트만).

---

## 다중 에이전트 라우팅

하나의 게이트웨이 안에 여러 개의 고립된 에이전트를 실행하세요. [Multi-Agent](/ko-KR/concepts/multi-agent) 를 참조하세요.

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

### 바인딩 매치 필드

- `match.channel` (필수)
- `match.accountId` (선택 사항; `*` = 모든 계정; 생략 시 기본 계정)
- `match.peer` (선택 사항; `{ kind: direct|group|channel, id }`)
- `match.guildId` / `match.teamId` (선택 사항; 채널별)

**결정론적 매치 순서:**

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (정확히, 동료/길드/팀 없음)
5. `match.accountId: "*"` (채널 전역)
6. 기본 에이전트

각 티어 내에서, 첫 번째 매치 `bindings` 항목이 승리합니다.

### 에이전트별 접근 프로필

<Accordion title="전체 접근 (샌드박스 없음)">

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

<Accordion title="읽기 전용 도구 + 워크스페이스">

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

<Accordion title="파일 시스템 접근 없음 (메시징 전용)">

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

자세한 우선 순위는 [Multi-Agent Sandbox & Tools](/ko-KR/tools/multi-agent-sandbox-tools) 를 참조하세요.

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
    mainKey: "main", // 레거시 (런타임에서는 항상 "main" 사용)
    agentToAgent: { maxPingPongTurns: 5 },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

<Accordion title="세션 필드 세부사항">

- **`dmScope`**: 다이렉트 메시지가 그룹화되는 방식입니다.
  - `main`: 모든 다이렉트 메시지 공유 메인 세션입니다.
  - `per-peer`: 채널 간 송신자 ID 별로 분리합니다.
  - `per-channel-peer`: 채널 + 송신자별로 분리합니다 (다중 사용자 받은 편지함에 권장됨).
  - `per-account-channel-peer`: 계정 + 채널 + 송신자별로 분리합니다 (다중 계정에 권장됨).
- **`identityLinks`**: 채널 간 세션 공유를 위한 표준 ID 와 프로바이더 접두사가 붙은 피어를 매핑합니다.
- **`reset`**: 주요 재설정 정책입니다. `daily` 는 현지 시간을 기준으로 `atHour` 에 재설정합니다; `idle` 은 `idleMinutes` 후에 재설정됩니다. 두 경우가 모두 설정된 경우, 먼저 만료된 것이 우승합니다.
- **`resetByType`**: 유형별 재설정 (`direct`, `group`, `thread`). 레거시 `dm` 은 `direct` 의 별칭으로 허용됩니다.
- **`mainKey`**: 레거시 필드. 런타임에서는 이제 항상 "main"을 메인 다이렉트 채팅 버킷으로 사용합니다.
- **`sendPolicy`**: `channel`, `chatType` (`direct|group|channel`, 레거시 `dm` 별칭 포함) 또는 `keyPrefix`, `rawKeyPrefix` 별로 매칭됩니다. 첫 번째 거부가 승리합니다.
- **`maintenance`**: `warn` 은 활성 세션에 퇴출 경고를 표시하며, `enforce` 는 가지치기와 회전을 적용합니다.

</Accordion>

---

## 메시지

```json5
{
  messages: {
    responsePrefix: "🦞", // 또는 "auto"
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
      debounceMs: 2000, // 0 비활성화
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
      },
    },
  },
}
```

### 응답 접두사

채널/계정별 재정의: `channels.<channel>.responsePrefix`, `channels.<channel>.accounts.<id>.responsePrefix` 를 확인하세요.

해결 순서 (가장 구체적인 것 우선): 계정 → 채널 → 글로벌. `""` 은 비활성화되며 연쇄를 멈춥니다. `"auto"` 는 `[{identity.name}]` 으로 정의됩니다.

**템플릿 변수:**

| 변수              | 설명                 | 예제                        |
| ----------------- | -------------------- | --------------------------- |
| `{model}`         | 약식 모델 이름       | `claude-opus-4-6`           |
| `{modelFull}`     | 전체 모델 식별자     | `anthropic/claude-opus-4-6` |
| `{provider}`      | 프로바이더 이름      | `anthropic`                 |
| `{thinkingLevel}` | 현재 사고 수준       | `high`, `low`, `off`        |
| `{identity.name}` | 에이전트 정체성 이름 | ( `"auto"` 와 동일)         |

변수는 대소문자를 구분하지 않습니다. `{think}` 는 `{thinkingLevel}` 의 별칭입니다.

### 수신 확인 반응

- 기본적으로 활성 에이전트의 `identity.emoji` 를 따르며, 그렇지 않은 경우 `"👀"` 을 따릅니다. `""` 으로 설정하여 비활성화 할 수 있습니다.
- 채널별 재정의: `channels.<channel>.ackReaction`, `channels.<channel>.accounts.<id>.ackReaction`.
- 해결 순서: 계정 → 채널 → `messages.ackReaction` → 정체성 폴백.
- 범위: `group-mentions` (기본값), `group-all`, `direct`, `all`.
- `removeAckAfterReply`: 응답 후 확인을 제거합니다 (Slack/Discord/Telegram/Google Chat 에만 해당).

### 인바운드 디바운스

단일 에이전트 턴으로 같은 송신자의 빠른 연속 텍스트-only 메시지를 배치합니다. 미디어/첨부 파일은 즉시 플러시됩니다. 제어 명령은 디바운싱을 우회합니다.

### TTS (text-to-speech)

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

- `auto` 는 자동 TTS 를 제어합니다. `/tts off|always|inbound|tagged` 는 세션별로 재정의합니다.
- `summaryModel` 은 자동 요약에 대해 `agents.defaults.model.primary` 를 재정의합니다.
- API 키는 `ELEVENLABS_API_KEY`/`XI_API_KEY` 와 `OPENAI_API_KEY` 로 대체됩니다.

---

## 대화

Talk 모드 (macOS/iOS/Android) 의 기본값입니다.

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

- 음성 ID 는 `ELEVENLABS_VOICE_ID` 또는 `SAG_VOICE_ID` 로 대체됩니다.
- `apiKey` 는 `ELEVENLABS_API_KEY` 로 대체됩니다.
- `voiceAliases` 를 통해 Talk 지시문에서 친숙한 이름을 사용할 수 있습니다.

---

## 도구

### 도구 프로필

`tools.profile` 은 `tools.allow`/`tools.deny` 전에 기본 허용 목록을 설정합니다:

| 프로필      | 포함 항목                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` 만                                                                       |
| `coding`    | `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`                    |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status` |
| `full`      | 제한 없음 (설정하지 않은 경우와 동일합니다)                                               |

### 도구 그룹

| 그룹               | 도구 명                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`, `process` (`bash` 는 `exec` 의 별칭으로 허용됨)                                  |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                   |
| `group:sessions`   | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` |
| `group:memory`     | `memory_search`, `memory_get`                                                            |
| `group:web`        | `web_search`, `web_fetch`                                                                |
| `group:ui`         | `browser`, `canvas`                                                                      |
| `group:automation` | `cron`, `gateway`                                                                        |
| `group:messaging`  | `message`                                                                                |
| `group:nodes`      | `nodes`                                                                                  |
| `group:openclaw`   | 모든 내장 도구 (프로바이더 플러그인은 제외)                                              |

### `tools.allow` / `tools.deny`

전역 도구 허용/거부 정책 (거부가 승리합니다). 대소문자를 구분하지 않으며 `*` 와일드카드를 지원합니다. Docker 샌드박스가 꺼져있을 때도 적용됩니다.

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

### `tools.byProvider`

특정 프로바이더나 모델에 대해 도구를 추가로 제한합니다. 순서: 기본 프로필 → 프로바이더 프로필 → 허용/거부.

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

상승된 (호스트) 실행 접근을 제어합니다:

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

- 에이전트별 재정의 (`agents.list[].tools.elevated`) 는 추가적인 제한만 적용할 수 있습니다.
- `/elevated on|off|ask|full` 은 세션별 상태를 저장하며, 인라인 지시는 단일 메시지에 적용됩니다.
- 상승된 `exec` 는 호스트에서 실행되며, 샌드박스 격리를 우회합니다.

### `tools.exec`

```json5
{
  tools: {
    exec: {
      backgroundMs: 10000,
      timeoutSec: 1800,
      cleanupMs: 1800000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      applyPatch: {
        enabled: false,
        allowModels: ["gpt-5.2"],
      },
    },
  },
}
```

### `tools.loopDetection`

도구 루프 안전 검사는 **기본적으로 비활성화** 되어 있습니다. 활성화를 위해 `enabled: true` 을 설정하십시오.
설정은 `tools.loopDetection` 에 전역으로 정의될 수 있으며, `agents.list[].tools.loopDetection` 에서 에이전트별로 재정의할 수 있습니다.

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `historySize`: 루프 분석을 위한 최대 도구 호출 기록 유지.
- `warningThreshold`: 경고를 위한 반복되는 비진전 패턴 임계값.
- `criticalThreshold`: 중요한 루프 차단을 위한 더 높은 임계값.
- `globalCircuitBreakerThreshold`: 어떤 비진전 실행이라도 하드 스톱 임계값.
- `detectors.genericRepeat`: 동일한 도구/동일한 인수의 반복된 호출 경고.
- `detectors.knownPollNoProgress`: 알려진 폴 도구 (`process.poll`, `command_status` 등) 에 대해 경고/차단.
- `detectors.pingPong`: 교차 반복 없는 진행 무패턴이 있는 경우 경고/차단.
- `warningThreshold >= criticalThreshold` 또는 `criticalThreshold >= globalCircuitBreakerThreshold` 면 검증 실패.

### `tools.web`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "brave_api_key", // 또는 BRAVE_API_KEY 환경 변수
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

인바운드 미디어 이해 (이미지/오디오/비디오) 를 구성합니다:

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

<Accordion title="미디어 모델 항목 필드">

**프로바이더 항목** (`type: "provider"` 또는 생략):

- `provider`: API 프로바이더 ID (`openai`, `anthropic`, `google`/`gemini`, `groq`, 등)
- `model`: 모델 ID 재정의
- `profile` / `preferredProfile`: 인증 프로필 선택

**CLI 항목** (`type: "cli"`):

- `command`: 실행할 실행 파일
- `args`: 템플릿화된 인수 ( `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}` 등을 지원)

**공통 필드:**

- `capabilities`: 선택적 목록 (`image`, `audio`, `video`). 기본값: `openai`/`anthropic`/`minimax` → 이미지, `google` → 이미지+오디오+비디오, `groq` → 오디오.
- `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`: 항목별 재정의.
- 실패 시, 다음 항목으로 대체됩니다.

프로바이더 인증은 표준 순서로 이루어집니다: 인증 프로필 → 환경 변수 → `models.providers.*.apiKey`.

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

### `tools.sessions`

세션 도구 (`sessions_list`, `sessions_history`, `sessions_send`) 에 의해 대상으로 할 수 있는 세션을 제어합니다.

기본값: `tree` (현재 세션 + 생성된 세션, 예: 하위 에이전트).

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      visibility: "tree",
    },
  },
}
```

메모:

- `self`: 현재 세션 키만.
- `tree`: 현재 세션 + 현재 세션에 의해 생성된 세션 (하위 에이전트).
- `agent`: 현재 에이전트 ID 에 속하는 모든 세션 (다른 사용자를 포함할 수 있음).
- `all`: 모든 세션. 여전히 `tools.agentToAgent` 를 통해 교차 에이전트 타깃이 필요합니다.
- 샌드박스 클램프: 현재 세션이 샌드박스 격리되고 `agents.defaults.sandbox.sessionToolsVisibility="spawned"` 인 경우 가시성은 여전히 `tree` 로 강제 고정됩니다.

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

- `model`: 생성된 하위 에이전트의 기본 모델. 지정되지 않은 경우, 하위 에이전트는 호출자의 모델을 상속합니다.
- 하위 에이전트 도구 정책: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`.

---

## 사용자 정의 프로바이더 및 기본 URL

OpenClaw 는 pi-coding-agent 모델 카탈로그를 사용합니다. `models.providers` 를 통해 사용자 정의 프로바이더를 추가하거나 `~/.openclaw/agents/<agentId>/agent/models.json` 에 추가하세요.

```json5
{
  models: {
    mode: "merge", // merge (기본값) | replace
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

- `authHeader: true` + `headers` 를 사용하여 사용자 정의 인증이 필요할 때 사용할 수 있습니다.
- 에이전트 구성 루트는 `OPENCLAW_AGENT_DIR` (또는 `PI_CODING_AGENT_DIR`) 로 재정의할 수 있습니다.

### 프로바이더 예제

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

Cerebras 를 위해 `cerebras/zai-glm-4.7` 를 사용합니다; Direct Z.AI 를 위해 `z.ai/glm-4.7` 를 사용하세요.

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

`OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`) 를 설정합니다. 단축키: `openclaw onboard --auth-choice opencode-zen`.

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

`ZAI_API_KEY` 를 설정합니다. `z.ai/*` 및 `z-ai/*` 가 허용된 별칭입니다. 단축키: `openclaw onboard --auth-choice zai-api-key`.

- 일반 엔드포인트: `https://api.z.ai/api/paas/v4`
- 코딩 엔드포인트 (기본값): `https://api.z.ai/api/coding/paas/v4`
- 일반 엔드포인트를 위해, 기본 URL 재정의가 있는 사용자 정의 프로바이더를 정의합니다.

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

중국 엔드포인트를 위해: `baseUrl: "https://api.moonshot.cn/v1"` 또는 `openclaw onboard --auth-choice moonshot-api-key-cn`.

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

Anthropic 호환, 내장 프로바이더. 단축키: `openclaw onboard --auth-choice kimi-code-api-key`.

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

기본 URL은 `/v1` 을 제외해야 합니다 (Anthropic 클라이언트가 이를 추가합니다). 단축키: `openclaw onboard --auth-choice synthetic-api-key`.

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

`MINIMAX_API_KEY` 를 설정합니다. 단축키: `openclaw onboard --auth-choice minimax-api`.

</Accordion>

<Accordion title="로컬 모델 (LM Studio)">

[로컬 모델](/ko-KR/gateway/local-models) 을 참조하세요. 간단히: LM Studio Responses API 를 통해 MiniMax M2.1 을 심각한 하드웨어에서 실행하세요; 대체로 호스팅된 모델들을 병합하여 유지합니다.

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

- `allowBundled`: 번들된 스킬만 사용하는 선택적 허용 목록 (관리된/워크스페이스 스킬은 영향을 받지 않음).
- `entries.<skillKey>.enabled: false` 는 스킬이 번들되거나 설치되었을 때도 비활성화합니다.
- `entries.<skillKey>.apiKey`: 주요 환경 변수를 선언하는 스킬의 편의성.

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

- `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, `plugins.load.paths` 에서 로드됩니다.
- **구성 변경 사항은 게이트웨이 재시작이 필요합니다.**
- `allow`: 선택적 허용 목록 (목록에 있는 플러그인만 로드). `deny` 가 우선합니다.

[Plugins](/ko-KR/tools/plugin) 을 참조하세요.

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

- `evaluateEnabled: false` 는 `act:evaluate` 와 `wait --fn` 을 비활성화합니다.
- 원격 프로필은 연결 전용입니다 (시작/중지/재설정 비활성화).
- 자동 감지 순서: Chromium 기반 기본 브라우저 → Chrome → Brave → Edge → Chromium → Chrome Canary.
- 제어 서비스: 루프백 전용 (포트는 `gateway.port` 에서 파생, 기본값 `18791`).

---

## UI

```json5
{
  ui: {
    seamColor: "#FF4500",
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // 이모지, 짧은 텍스트, 이미지 URL 또는 data URI
    },
  },
}
```

- `seamColor`: 네이티브 앱 UI 크롬의 강조 색상 (Talk Mode 버블 색상 등).
- `assistant`: Control UI 정체성 재정의. 활성 에이전트 정체성으로 대체됩니다.

---

## 게이트웨이

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    auth: {
      mode: "token", // none | token | password | trusted-proxy
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
      // trustedProxy: { userHeader: "x-forwarded-user" }, // for mode=trusted-proxy; see /gateway/trusted-proxy-auth
      allowTailscale: true,
      rateLimit: {
        maxAttempts: 10,
        windowMs: 60000,
        lockoutMs: 300000,
        exemptLoopback: true,
      },
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
    tools: {
      // Additional /tools/invoke HTTP denies
      deny: ["browser"],
      // Remove tools from the default HTTP deny list
      allow: ["gateway"],
    },
  },
}
```

<Accordion title="게이트웨이 필드 세부사항">

- `mode`: `local` (게이트웨이 실행) 또는 `remote` (원격 게이트웨이에 연결). 게이트웨이는 `local` 이 아닌 경우 시작을 거부합니다.
- `port`: WS + HTTP 용 단일 다중화 포트. 우선순위: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > `18789`.
- `bind`: `auto`, `loopback` (기본값), `lan` (`0.0.0.0`), `tailnet` (Tailscale IP 전용) 또는 `custom`.
- **인증**: 기본적으로 필수입니다. 비루프백 바인드는 공유 토큰/비밀번호가 필요합니다. 온보딩 마법사는 기본적으로 토큰을 생성합니다.
- `auth.mode: "none"`: 명시적 인증 없음 모드. 신뢰할 수 있는 로컬 루프백 설정에서만 사용하세요; 온보딩 프롬프트에서는 의도적으로 제공되지 않습니다.
- `auth.mode: "trusted-proxy"`: 인증을 인식하는 리버스 프록시에 인증을 위임하고 `gateway.trustedProxies` 의 ID 헤더를 신뢰합니다 ([Trusted Proxy Auth](/ko-KR/gateway/trusted-proxy-auth) 참조).
- `auth.allowTailscale`: `true` 이면 Tailscale Serve ID 헤더가 인증을 충족합니다 (`tailscale whois` 를 통해 확인). `tailscale.mode = "serve"` 일 때 기본값은 `true` 입니다.
- `auth.rateLimit`: 선택적 인증 실패 제한기. 클라이언트 IP 별 및 인증 범위별로 적용됩니다 (공유 비밀과 디바이스 토큰은 독립적으로 추적됩니다). 차단된 시도는 `429` + `Retry-After` 를 반환합니다.
  - `auth.rateLimit.exemptLoopback` 은 기본값이 `true` 입니다; 의도적으로 localhost 트래픽도 속도 제한하려면 `false` 로 설정하세요 (테스트 설정 또는 엄격한 프록시 배포용).
- `tailscale.mode`: `serve` (tailnet 전용, 루프백 바인드) 또는 `funnel` (공개, 인증 필요).
- `remote.transport`: `ssh` (기본값) 또는 `direct` (ws/wss). `direct` 의 경우, `remote.url` 은 `ws://` 또는 `wss://` 여야 합니다.
- `gateway.remote.token` 은 원격 CLI 호출 전용이며, 로컬 게이트웨이 인증을 활성화하지 않습니다.
- `trustedProxies`: TLS 를 종료하는 리버스 프록시 IP. 제어하는 프록시만 나열하세요.
- `gateway.tools.deny`: HTTP `POST /tools/invoke` 에 대해 차단되는 추가 도구 이름 (기본 거부 목록을 확장).
- `gateway.tools.allow`: 기본 HTTP 거부 목록에서 도구 이름을 제거합니다.

</Accordion>

### OpenAI 호환 엔드포인트

- Chat Completions: 기본적으로 비활성화. `gateway.http.endpoints.chatCompletions.enabled: true` 로 활성화합니다.
- Responses API: `gateway.http.endpoints.responses.enabled`.
- Responses URL 입력 강화:
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`

### 다중 인스턴스 격리

고유한 포트와 상태 디렉토리로 하나의 호스트에서 여러 게이트웨이를 실행합니다:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

편의 플래그: `--dev` (`~/.openclaw-dev` + 포트 `19001` 사용), `--profile <name>` (`~/.openclaw-<name>` 사용).

[Multiple Gateways](/ko-KR/gateway/multiple-gateways) 를 참조하세요.

---

## 훅

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
    transformsDir: "~/.openclaw/hooks/transforms",
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
  - 요청 페이로드의 `sessionKey` 는 `hooks.allowRequestSessionKey=true` (기본값: `false`) 인 경우에만 허용됩니다.
- `POST /hooks/<name>` → `hooks.mappings` 를 통해 해결됩니다

<Accordion title="매핑 세부사항">

- `match.path` 는 `/hooks` 이후의 하위 경로를 매치합니다 (예: `/hooks/gmail` → `gmail`).
- `match.source` 는 일반 경로에 대한 페이로드 필드를 매치합니다.
- `{{messages[0].subject}}` 같은 템플릿은 페이로드에서 읽습니다.
- `transform` 은 훅 액션을 반환하는 JS/TS 모듈을 가리킬 수 있습니다.
  - `transform.module` 은 반드시 상대 경로여야 하며, `hooks.transformsDir` 내에 있어야 합니다 (절대 경로와 경로 탐색은 거부됩니다).
- `agentId` 는 특정 에이전트로 라우팅합니다; 알 수 없는 ID 는 기본 에이전트로 대체됩니다.
- `allowedAgentIds`: 명시적 라우팅을 제한합니다 (`*` 또는 생략 = 모두 허용, `[]` = 모두 거부).
- `defaultSessionKey`: 명시적 `sessionKey` 없이 훅 에이전트 실행을 위한 선택적 고정 세션 키.
- `allowRequestSessionKey`: `/hooks/agent` 호출자가 `sessionKey` 를 설정할 수 있도록 허용합니다 (기본값: `false`).
- `allowedSessionKeyPrefixes`: 명시적 `sessionKey` 값 (요청 + 매핑) 에 대한 선택적 접두사 허용 목록, 예: `["hook:"]`.
- `deliver: true` 는 최종 응답을 채널로 보냅니다; `channel` 은 기본적으로 `last` 입니다.
- `model` 은 이 훅 실행에 대한 LLM 을 재정의합니다 (모델 카탈로그가 설정된 경우 허용되어야 함).

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

- 게이트웨이는 구성된 경우 부팅 시 자동으로 `gog gmail watch serve` 를 시작합니다. 비활성화하려면 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 을 설정하세요.
- 게이트웨이와 함께 별도의 `gog gmail watch serve` 를 실행하지 마세요.

---

## Canvas 호스트

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    liveReload: true,
    // enabled: false, // or OPENCLAW_SKIP_CANVAS_HOST=1
  },
}
```

- 게이트웨이 포트 아래에서 에이전트가 편집 가능한 HTML/CSS/JS 와 A2UI 를 HTTP 로 제공합니다:
  - `http://<gateway-host>:<gateway.port>/__openclaw__/canvas/`
  - `http://<gateway-host>:<gateway.port>/__openclaw__/a2ui/`
- 로컬 전용: `gateway.bind: "loopback"` (기본값) 을 유지하세요.
- 비루프백 바인드: canvas 라우트에는 게이트웨이 인증 (토큰/비밀번호/trusted-proxy) 이 필요하며, 다른 게이트웨이 HTTP 표면과 동일합니다.
- Node WebView 는 일반적으로 인증 헤더를 보내지 않습니다; 노드가 페어링되고 연결된 후, 게이트웨이는 canvas/A2UI 접근을 위한 노드 범위 캐퍼빌리티 URL을 게시합니다.
- 캐퍼빌리티 URL은 활성 노드 WS 세션에 바인딩되며 빠르게 만료됩니다. IP 기반 폴백은 사용되지 않습니다.
- 제공된 HTML 에 라이브 리로드 클라이언트를 삽입합니다.
- 비어있을 때 시작 `index.html` 을 자동으로 생성합니다.
- `/__openclaw__/a2ui/` 에서 A2UI 도 제공합니다.
- 변경 사항은 게이트웨이 재시작이 필요합니다.
- 대규모 디렉토리 또는 `EMFILE` 오류의 경우 라이브 리로드를 비활성화하세요.

---

## 디스커버리

### mDNS (Bonjour)

```json5
{
  discovery: {
    mdns: {
      mode: "minimal", // minimal | full | off
    },
  },
}
```

- `minimal` (기본값): TXT 레코드에서 `cliPath` + `sshPort` 를 생략합니다.
- `full`: `cliPath` + `sshPort` 를 포함합니다.
- 호스트 이름은 기본적으로 `openclaw` 입니다. `OPENCLAW_MDNS_HOSTNAME` 으로 재정의하세요.

### 와이드 에어리어 (DNS-SD)

```json5
{
  discovery: {
    wideArea: { enabled: true },
  },
}
```

`~/.openclaw/dns/` 아래에 유니캐스트 DNS-SD 존을 작성합니다. 네트워크 간 디스커버리를 위해 DNS 서버 (CoreDNS 권장) + Tailscale 스플릿 DNS 와 페어링하세요.

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

- 인라인 환경 변수는 프로세스 환경에 키가 없는 경우에만 적용됩니다.
- `.env` 파일: CWD `.env` + `~/.openclaw/.env` (기존 변수를 재정의하지 않음).
- `shellEnv`: 로그인 셸 프로필에서 누락된 예상 키를 가져옵니다.
- 전체 우선순위는 [Environment](/ko-KR/help/environment) 를 참조하세요.

### 환경 변수 대체

구성 문자열에서 `${VAR_NAME}` 으로 환경 변수를 참조합니다:

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- 대문자 이름만 매치됩니다: `[A-Z_][A-Z0-9_]*`.
- 누락되거나 비어있는 변수는 구성 로드 시 오류를 발생시킵니다.
- 리터럴 `${VAR}` 을 위해 `$${VAR}` 로 이스케이프합니다.
- `$include` 와 함께 작동합니다.

---

## 인증 저장소

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

- 에이전트별 인증 프로필은 `<agentDir>/auth-profiles.json` 에 저장됩니다.
- `~/.openclaw/credentials/oauth.json` 에서 레거시 OAuth 가져오기.
- [OAuth](/ko-KR/concepts/oauth) 를 참조하세요.

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

- 기본 로그 파일: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`.
- 안정적인 경로를 위해 `logging.file` 을 설정하세요.
- `--verbose` 사용 시 `consoleLevel` 이 `debug` 로 올라갑니다.

---

## 마법사

CLI 마법사 (`onboard`, `configure`, `doctor`) 가 작성한 메타데이터:

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

## 정체성

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

macOS 온보딩 어시스턴트가 작성합니다. 기본값을 유도합니다:

- `identity.emoji` 에서 `messages.ackReaction` (대체: 👀)
- `identity.name`/`identity.emoji` 에서 `mentionPatterns`
- `avatar` 허용: 워크스페이스 상대 경로, `http(s)` URL 또는 `data:` URI

---

## 브리지 (레거시, 제거됨)

현재 빌드에는 TCP 브리지가 포함되어 있지 않습니다. 노드는 게이트웨이 WebSocket 을 통해 연결됩니다. `bridge.*` 키는 더 이상 구성 스키마의 일부가 아닙니다 (제거될 때까지 검증 실패; `openclaw doctor --fix` 로 알 수 없는 키를 제거할 수 있습니다).

<Accordion title="레거시 브리지 구성 (역사적 참고)">

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

## Cron

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
    webhook: "https://example.invalid/legacy", // 저장된 notify:true 작업을 위한 사용 중단된 대체
    webhookToken: "replace-with-dedicated-token", // 아웃바운드 웹훅 인증을 위한 선택적 Bearer 토큰
    sessionRetention: "24h", // 지속시간 문자열 또는 false
  },
}
```

- `sessionRetention`: 완료된 cron 세션을 정리하기 전에 유지할 기간. 기본값: `24h`.
- `webhookToken`: cron 웹훅 POST 전달 (`delivery.mode = "webhook"`) 에 사용되는 Bearer 토큰, 생략 시 인증 헤더가 전송되지 않습니다.
- `webhook`: 사용 중단된 레거시 대체 웹훅 URL (http/https), `notify: true` 가 여전히 있는 저장된 작업에만 사용됩니다.

[Cron Jobs](/ko-KR/automation/cron-jobs) 를 참조하세요.

---

## 미디어 모델 템플릿 변수

`tools.media.*.models[].args` 에서 확장되는 템플릿 플레이스홀더:

| 변수               | 설명                                             |
| ------------------ | ------------------------------------------------ |
| `{{Body}}`         | 전체 인바운드 메시지 본문                        |
| `{{RawBody}}`      | 원시 본문 (기록/발신자 래퍼 없음)                |
| `{{BodyStripped}}` | 그룹 언급이 제거된 본문                          |
| `{{From}}`         | 발신자 식별자                                    |
| `{{To}}`           | 수신자 식별자                                    |
| `{{MessageSid}}`   | 채널 메시지 ID                                   |
| `{{SessionId}}`    | 현재 세션 UUID                                   |
| `{{IsNewSession}}` | 새 세션 생성 시 `"true"`                         |
| `{{MediaUrl}}`     | 인바운드 미디어 의사 URL                         |
| `{{MediaPath}}`    | 로컬 미디어 경로                                 |
| `{{MediaType}}`    | 미디어 유형 (image/audio/document/...)           |
| `{{Transcript}}`   | 오디오 트랜스크립트                              |
| `{{Prompt}}`       | CLI 항목에 대한 해결된 미디어 프롬프트           |
| `{{MaxChars}}`     | CLI 항목에 대한 해결된 최대 출력 문자 수         |
| `{{ChatType}}`     | `"direct"` 또는 `"group"`                        |
| `{{GroupSubject}}` | 그룹 주제 (최선의 노력)                          |
| `{{GroupMembers}}` | 그룹 멤버 미리보기 (최선의 노력)                 |
| `{{SenderName}}`   | 발신자 표시 이름 (최선의 노력)                   |
| `{{SenderE164}}`   | 발신자 전화번호 (최선의 노력)                    |
| `{{Provider}}`     | 프로바이더 힌트 (whatsapp, telegram, discord 등) |

---

## 구성 인클루드 (`$include`)

구성을 여러 파일로 분할합니다:

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

- 단일 파일: 포함하는 객체를 대체합니다.
- 파일 배열: 순서대로 깊은 병합 (이후 것이 이전 것을 재정의).
- 형제 키: 인클루드 후 병합 (인클루드된 값을 재정의).
- 중첩 인클루드: 최대 10 레벨 깊이.
- 경로: 인클루드하는 파일을 기준으로 해석되지만, 최상위 구성 디렉토리 (메인 구성 파일의 `dirname`) 내에 있어야 합니다. 절대/`../` 형식은 여전히 해당 경계 내에서 해석되는 경우에만 허용됩니다.
- 오류: 누락된 파일, 파싱 오류 및 순환 인클루드에 대한 명확한 메시지.

---

_관련: [구성](/ko-KR/gateway/configuration) · [구성 예제](/ko-KR/gateway/configuration-examples) · [Doctor](/ko-KR/gateway/doctor)_
