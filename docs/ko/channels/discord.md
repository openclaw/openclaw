---
summary: "Discord 봇 지원 상태, 기능, 구성"
read_when:
  - Discord 채널 기능 작업 중일 때
title: "Discord"
---

# Discord (Bot API)

상태: 공식 Discord 봇 게이트웨이를 통해 다이렉트 메시지와 길드 텍스트 채널을 지원할 준비가 되어 있습니다.

## 빠른 설정 (초보자)

1. Discord 봇을 생성하고 봇 토큰을 복사합니다.
2. Discord 앱 설정에서 **Message Content Intent** 를 활성화합니다 (허용 목록 또는 이름 조회를 사용할 계획이라면 **Server Members Intent** 도 함께 활성화합니다).
3. OpenClaw 에 토큰을 설정합니다:
   - 환경 변수: `DISCORD_BOT_TOKEN=...`
   - 또는 설정: `channels.discord.token: "..."`.
   - 둘 다 설정된 경우 설정이 우선합니다 (환경 변수 폴백은 기본 계정 전용입니다).
4. 메시지 권한과 함께 봇을 서버에 초대합니다 (다이렉트 메시지만 원한다면 개인 서버를 생성합니다).
5. Gateway(게이트웨이) 를 시작합니다.
6. 첫 접촉 시 페어링 코드를 승인합니다.

최소 설정:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## 목표

- Discord 다이렉트 메시지 또는 길드 채널을 통해 OpenClaw 와 대화합니다.
- 다이렉트 채팅은 에이전트의 메인 세션으로 병합됩니다 (기본값 `agent:main:main`). 길드 채널은 `agent:<agentId>:discord:channel:<channelId>` 로 격리되며 (표시 이름은 `discord:<guildSlug>#<channelSlug>` 사용).
- 그룹 다이렉트 메시지는 기본적으로 무시됩니다. `channels.discord.dm.groupEnabled` 로 활성화하고, 선택적으로 `channels.discord.dm.groupChannels` 로 제한할 수 있습니다.
- 라우팅을 결정론적으로 유지합니다. 응답은 항상 수신된 채널로 되돌아갑니다.

## 동작 방식

1. Discord 애플리케이션 → Bot 을 생성하고 필요한 인텐트 (DM + 길드 메시지 + 메시지 콘텐츠) 를 활성화한 뒤 봇 토큰을 가져옵니다.
2. 사용하려는 위치에서 메시지를 읽고/보낼 수 있도록 필요한 권한과 함께 봇을 서버에 초대합니다.
3. OpenClaw 를 `channels.discord.token` 으로 설정합니다 (또는 폴백으로 `DISCORD_BOT_TOKEN`).
4. Gateway(게이트웨이) 를 실행합니다. 토큰이 사용 가능하고 (설정 우선, 환경 변수 폴백) `channels.discord.enabled` 가 `false` 이 아닐 경우 Discord 채널이 자동으로 시작됩니다.
   - 환경 변수를 선호한다면 `DISCORD_BOT_TOKEN` 을 설정합니다 (설정 블록은 선택 사항입니다).
5. 다이렉트 채팅: 전달 시 `user:<id>` (또는 `<@id>` 멘션) 을 사용합니다. 모든 턴은 공유된 `main` 세션으로 들어갑니다. Bare numeric IDs are ambiguous and rejected.
6. 길드 채널: 전달에 `channel:<channelId>` 을 사용합니다. 기본적으로 멘션이 필요하며, 길드 또는 채널별로 설정할 수 있습니다.
7. 다이렉트 채팅: 기본적으로 `channels.discord.dm.policy` 로 보안이 적용됩니다 (기본값: `"pairing"`). 알 수 없는 발신자는 페어링 코드를 받습니다 (1 시간 후 만료). `openclaw pairing approve discord <code>` 로 승인합니다.
   - 이전의 ‘누구나 허용’ 동작을 유지하려면 `channels.discord.dm.policy="open"` 와 `channels.discord.dm.allowFrom=["*"]` 을 설정합니다.
   - 강제 허용 목록을 사용하려면 `channels.discord.dm.policy="allowlist"` 을 설정하고 `channels.discord.dm.allowFrom` 에 발신자를 나열합니다.
   - 모든 다이렉트 메시지를 무시하려면 `channels.discord.dm.enabled=false` 또는 `channels.discord.dm.policy="disabled"` 을 설정합니다.
8. 그룹 다이렉트 메시지는 기본적으로 무시됩니다. `channels.discord.dm.groupEnabled` 로 활성화하고, 선택적으로 `channels.discord.dm.groupChannels` 로 제한할 수 있습니다.
9. 선택적 길드 규칙: 길드 id (권장) 또는 슬러그를 키로 하는 `channels.discord.guilds` 을 설정하고 채널별 규칙을 지정합니다.
10. 선택적 네이티브 명령어: `commands.native` 는 기본값이 `"auto"` 입니다 (Discord/Telegram 는 켜짐, Slack 은 꺼짐). `channels.discord.commands.native: true|false|"auto"` 으로 재정의할 수 있으며, `false` 은 이전에 등록된 명령을 제거합니다. 텍스트 명령은 `commands.text` 로 제어되며 단독 `/...` 메시지로 전송되어야 합니다. 명령에 대한 접근 그룹 검사를 우회하려면 `commands.useAccessGroups: false` 을 사용합니다.
    - 전체 명령 목록 및 설정: [슬래시 명령어](/tools/slash-commands)
11. 선택적 길드 컨텍스트 히스토리: 멘션에 응답할 때 마지막 N 개의 길드 메시지를 컨텍스트로 포함하려면 `channels.discord.historyLimit` (기본값 20, `messages.groupChat.historyLimit` 로 폴백) 을 설정합니다. 비활성화하려면 `0` 을 설정합니다.
12. 반응: 에이전트는 `discord` 도구를 통해 반응을 트리거할 수 있습니다 (`channels.discord.actions.*` 로 제어).
    - 반응 제거 의미론: [/tools/reactions](/tools/reactions) 를 참고하십시오.
    - `discord` 도구는 현재 채널이 Discord 인 경우에만 노출됩니다.
13. 네이티브 명령은 공유된 `main` 세션이 아니라 격리된 세션 키 (`agent:<agentId>:discord:slash:<userId>`) 를 사용합니다.

참고: 이름 → id 해석은 길드 멤버 검색을 사용하며 Server Members Intent 가 필요합니다. 봇이 멤버를 검색할 수 없다면 id 또는 `<@id>` 멘션을 사용하십시오.
참고: 슬러그는 소문자이며 공백은 `-` 로 대체됩니다. 채널 이름은 선행 `#` 없이 슬러그화됩니다.
참고: 길드 컨텍스트의 `[from:]` 줄에는 핑 가능한 응답을 쉽게 만들기 위해 `author.tag` + `id` 가 포함됩니다.

## 설정 쓰기

기본적으로 Discord 는 `/config set|unset` 에 의해 트리거되는 설정 업데이트를 작성할 수 있습니다 (`commands.config: true` 필요).

다음으로 비활성화합니다:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## How to create your own bot

이는 `#help` 와 같은 서버 (길드) 채널에서 OpenClaw 를 실행하기 위한 “Discord Developer Portal” 설정입니다.

### 1. Discord 앱 + 봇 사용자 생성

1. Discord Developer Portal → **Applications** → **New Application**
2. In your app:
   - **Bot** → **Add Bot**
   - **Bot Token** 을 복사합니다 (이를 `DISCORD_BOT_TOKEN` 에 입력합니다)

### 2) OpenClaw 에 필요한 게이트웨이 인텐트 활성화

Discord 는 명시적으로 활성화하지 않으면 “권한 인텐트” 를 차단합니다.

**Bot** → **Privileged Gateway Intents** 에서 다음을 활성화합니다:

- **Message Content Intent** (대부분의 길드에서 메시지 텍스트를 읽는 데 필요하며, 없으면 “Used disallowed intents” 가 표시되거나 봇이 연결되지만 메시지에 반응하지 않습니다)
- **Server Members Intent** (권장; 길드에서 일부 멤버/사용자 조회 및 허용 목록 매칭에 필요)

일반적으로 **Presence Intent** 는 필요하지 않습니다. 봇 자신의 프레즌스를 설정하는 것 (`setPresence` 액션) 은 게이트웨이 OP3 를 사용하며 이 인텐트가 필요하지 않습니다. 다른 길드 멤버의 프레즌스 업데이트를 수신하려는 경우에만 필요합니다.

### 3. 초대 URL 생성 (OAuth2 URL Generator)

앱에서: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (네이티브 명령에 필요)

**Bot Permissions** (최소 기준)

- ✅ 채널 보기
- ✅ 메시지 보내기
- ✅ 메시지 기록 읽기
- ✅ 링크 임베드
- ✅ 파일 첨부
- ✅ 반응 추가 (선택 사항이지만 권장)
- ✅ 외부 이모지 / 스티커 사용 (선택 사항; 필요할 경우에만)

디버깅 중이며 봇을 완전히 신뢰하지 않는 한 **Administrator** 는 피하십시오.

생성된 URL 을 복사하여 열고 서버를 선택한 뒤 봇을 설치합니다.

### 4. id 가져오기 (길드/사용자/채널)

Discord 는 모든 곳에서 숫자 id 를 사용하며 OpenClaw 설정은 id 를 선호합니다.

1. Discord (데스크톱/웹) → **User Settings** → **Advanced** → **Developer Mode** 활성화
2. 우클릭:
   - 서버 이름 → **Copy Server ID** (길드 id)
   - 채널 (예: `#help`) → **Copy Channel ID**
   - 사용자 → **Copy User ID**

### 5) OpenClaw 설정

#### 토큰

Set the bot token via env var (recommended on servers):

- `DISCORD_BOT_TOKEN=...`

또는 설정으로:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

다중 계정 지원: 계정별 토큰과 선택적 `name` 를 사용하여 `channels.discord.accounts` 를 설정합니다. 공통 패턴은 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 를 참고하십시오.

#### 허용 목록 + 채널 라우팅

예시 “단일 서버, 나만 허용, #help 만 허용”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
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

참고 사항:

- `requireMention: true` 은 멘션된 경우에만 봇이 응답함을 의미합니다 (공유 채널에 권장).
- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`) 도 길드 메시지에서 멘션으로 간주됩니다.
- 다중 에이전트 재정의: `agents.list[].groupChat.mentionPatterns` 에 에이전트별 패턴을 설정합니다.
- `channels` 이 존재하면 나열되지 않은 모든 채널은 기본적으로 거부됩니다.
- 모든 채널에 기본값을 적용하려면 `"*"` 채널 항목을 사용합니다. 명시적 채널 항목이 와일드카드를 재정의합니다.
- 스레드는 부모 채널 설정 (허용 목록, `requireMention`, skills, 프롬프트 등) 을 상속합니다. 스레드 채널 id 를 명시적으로 추가하지 않는 한 동일합니다.
- 소유자 힌트: 길드별 또는 채널별 `users` 허용 목록이 발신자와 일치하면 OpenClaw 는 시스템 프롬프트에서 해당 발신자를 소유자로 취급합니다. 채널 전역 소유자를 지정하려면 `commands.ownerAllowFrom` 를 설정합니다.
- 봇이 작성한 메시지는 기본적으로 무시됩니다. 허용하려면 `channels.discord.allowBots=true` 을 설정합니다 (자신의 메시지는 계속 필터링됩니다).
- 경고: 다른 봇에 대한 응답을 허용하는 경우 (`channels.discord.allowBots=true`), `requireMention`, `channels.discord.guilds.*.channels.<id>.users` 허용 목록 및/또는 `AGENTS.md` 과 `SOUL.md` 의 가드레일을 사용하여 봇 간 응답 루프를 방지하십시오.

### 6. 동작 확인

1. Gateway(게이트웨이) 를 시작합니다.
2. 서버 채널에서 `@Krill hello` 를 전송합니다 (또는 봇 이름).
3. 아무 반응이 없으면 아래 **문제 해결** 을 확인하십시오.

### 문제 해결

- 먼저 `openclaw doctor` 과 `openclaw channels status --probe` 를 실행합니다 (조치 가능한 경고 + 빠른 감사).
- **“Used disallowed intents”**: Developer Portal 에서 **Message Content Intent** (그리고 대개 **Server Members Intent**) 를 활성화한 뒤 Gateway(게이트웨이) 를 재시작하십시오.
- **봇이 연결되지만 길드 채널에서 응답하지 않음**:
  - **Message Content Intent** 누락, 또는
  - 봇에 채널 권한 (보기/전송/기록 읽기) 이 없음, 또는
  - Your config requires mentions and you didn’t mention it, or
  - 길드/채널 허용 목록이 채널/사용자를 거부함.
- **`requireMention: false` 이지만 여전히 응답 없음**:
- `groupPolicy`: 길드 채널 처리 제어 (`open|disabled|allowlist`).`allowlist` 는 채널 허용 목록이 필요합니다.
  - `DISCORD_BOT_TOKEN` 만 설정하고 `channels.discord` 섹션을 생성하지 않으면, 런타임은
    `groupPolicy` 를 `open` 로 기본 설정합니다. 이를 잠그려면 `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` 또는 길드/채널 허용 목록을 추가하십시오.
- `requireMention` 은 `channels.discord.guilds` 아래 (또는 특정 채널 아래) 에 있어야 합니다. 최상위의 `channels.discord.requireMention` 은 무시됩니다.
- **권한 감사** (`channels status --probe`) 는 숫자 채널 ID 만 검사합니다. 슬러그/이름을 `channels.discord.guilds.*.channels` 키로 사용하면 감사에서 권한을 검증할 수 없습니다.
- **다이렉트 메시지가 동작하지 않음**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, 또는 아직 승인되지 않았습니다 (`channels.discord.dm.policy="pairing"`).
- **Discord 에서 exec 승인**: Discord 는 다이렉트 메시지에서 exec 승인을 위한 **버튼 UI** 를 지원합니다 (한 번 허용 / 항상 허용 / 거부). `/approve <id> ...` 는 전달된 승인에만 해당하며 Discord 의 버튼 프롬프트를 해결하지 못합니다. `❌ Failed to submit approval: Error: unknown approval id` 가 보이거나 UI 가 표시되지 않으면 다음을 확인하십시오:
  - 설정의 `channels.discord.execApprovals.enabled: true`.
  - Discord 사용자 ID 가 `channels.discord.execApprovals.approvers` 에 포함되어 있는지 (UI 는 승인자에게만 전송됩니다).
  - 다이렉트 메시지 프롬프트의 버튼 (**한 번 허용**, **항상 허용**, **거부**) 을 사용하십시오.
  - 전체 승인 및 명령 흐름은 [Exec 승인](/tools/exec-approvals) 과 [슬래시 명령어](/tools/slash-commands) 를 참고하십시오.

## 기능 및 제한

- 다이렉트 메시지와 길드 텍스트 채널 (스레드는 별도 채널로 취급되며 음성은 지원되지 않음).
- 입력 중 표시기는 최선 노력으로 전송됩니다. 메시지 분할은 `channels.discord.textChunkLimit` (기본값 2000) 을 사용하며, 긴 응답은 줄 수 기준으로 분할됩니다 (`channels.discord.maxLinesPerMessage`, 기본값 17).
- 선택적 줄바꿈 분할: 길이 분할 전에 빈 줄 (문단 경계) 기준으로 분할하려면 `channels.discord.chunkMode="newline"` 을 설정합니다.
- 파일 업로드는 설정된 `channels.discord.mediaMaxMb` 까지 지원됩니다 (기본값 8 MB).
- 기본적으로 멘션 기반 길드 응답을 사용하여 소음이 많은 봇을 방지합니다.
- 메시지가 다른 메시지를 참조하면 응답 컨텍스트가 주입됩니다 (인용된 콘텐츠 + id).
- 네이티브 답글 스레딩은 **기본적으로 꺼져 있음**. `channels.discord.replyToMode` 와 답글 태그로 활성화합니다.

## 재시도 정책

외부 Discord API 호출은 레이트 리밋 (429) 발생 시 Discord `retry_after` 가 사용 가능하면 이를 사용하여 지수 백오프와 지터로 재시도합니다. `channels.discord.retry` 로 설정합니다. 자세한 내용은 [재시도 정책](/concepts/retry) 을 참고하십시오.

## 설정

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
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
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Ack 반응은 전역적으로 `messages.ackReaction` +
`messages.ackReactionScope` 으로 제어됩니다. 봇이 응답한 후
ack 반응을 제거하려면 `messages.removeAckAfterReply` 을 사용합니다.

- `dm.enabled`: 모든 다이렉트 메시지를 무시하려면 `false` 로 설정합니다 (기본값 `true`).
- `dm.policy`: 다이렉트 메시지 접근 제어 (`pairing` 권장). `"open"` 는 `dm.allowFrom=["*"]` 가 필요합니다.
- `dm.allowFrom`: 다이렉트 메시지 허용 목록 (사용자 id 또는 이름). `dm.policy="allowlist"` 및 `dm.policy="open"` 검증에 사용됩니다. 마법사는 사용자 이름을 받아 봇이 멤버를 검색할 수 있을 때 id 로 해석합니다.
- `dm.groupEnabled`: 그룹 다이렉트 메시지 활성화 (기본값 `false`).
- `dm.groupChannels`: 그룹 다이렉트 메시지 채널 id 또는 슬러그에 대한 선택적 허용 목록.
- `channels.discord.groupPolicy` 의 기본값은 **allowlist** 입니다. 이를 `"open"` 로 설정하거나 `channels.discord.guilds` 아래에 길드 항목을 추가하십시오 (선택적으로 `channels.discord.guilds.<id> .channels` 아래에 채널을 나열하여 제한).
- `guilds`: 길드 id (권장) 또는 슬러그를 키로 하는 길드별 규칙.
- `guilds."*"`: 명시적 항목이 없을 때 적용되는 길드별 기본 설정.
- `guilds.<id>.slug`: 표시 이름에 사용되는 선택적 친화적 슬러그.
- `guilds.<id>.users`: 선택적 길드별 사용자 허용 목록 (id 또는 이름).
- `guilds.<id>.tools`: 채널 재정의가 없을 때 사용되는 길드 수준의 선택적 도구 정책 재정의 (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.toolsBySender`: 채널 재정의가 없을 때 적용되는 길드 수준의 발신자별 선택적 도구 정책 재정의 (`"*"` 와일드카드 지원).
- `guilds.<id>.channels.<channel>.allow`: `groupPolicy="allowlist"` 인 경우 채널 허용/거부.
- `guilds.<id>.channels.<channel>.requireMention`: 채널에 대한 멘션 게이팅.
- `guilds.<id>.channels.<channel>.tools`: 채널별 선택적 도구 정책 재정의 (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: 채널 내 발신자별 선택적 도구 정책 재정의 (`"*"` 와일드카드 지원).
- `guilds.<id>.channels.<channel>.users`: 채널별 선택적 사용자 허용 목록.
- `guilds.<id>.channels.<channel>.skills`: skill 필터 (생략 = 모든 skills, 비어 있음 = 없음).
- `guilds.<id>.channels.<channel>.systemPrompt`: 채널에 대한 추가 시스템 프롬프트. Discord 채널 주제는 **신뢰되지 않은** 컨텍스트로 주입됩니다 (시스템 프롬프트 아님).
- `guilds.<id>.channels.<channel>.enabled`: `false` 로 설정하면 채널을 비활성화합니다.
- `guilds.<id>.channels`: 채널 규칙 (키는 채널 슬러그 또는 id).
- `guilds.<id>.requireMention`: 길드별 멘션 요구 사항 (채널별로 재정의 가능).
- `guilds.<id>.reactionNotifications`: 반응 시스템 이벤트 모드 (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: 아웃바운드 텍스트 분할 크기 (문자). 기본값: 2000.
- `chunkMode`: `length` (기본값) 은 `textChunkLimit` 초과 시에만 분할합니다. `newline` 는 길이 분할 전에 빈 줄 (문단 경계) 기준으로 분할합니다.
- `maxLinesPerMessage`: 메시지당 최대 줄 수 (소프트). 기본값: 17.
- `mediaMaxMb`: 디스크에 저장되는 인바운드 미디어를 제한합니다.
- `historyLimit`: 멘션에 응답할 때 컨텍스트로 포함할 최근 길드 메시지 수 (기본값 20; `messages.groupChat.historyLimit` 로 폴백; `0` 는 비활성화).
- `dmHistoryLimit`: 사용자 턴 기준 다이렉트 메시지 히스토리 제한. 사용자별 재정의: `dms["<user_id>"].historyLimit`.
- `retry`: 외부 Discord API 호출에 대한 재시도 정책 (시도 횟수, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: PluralKit 프록시 메시지를 해석하여 시스템 멤버가 서로 다른 발신자로 표시되도록 합니다.
- `actions`: 액션별 도구 게이트. 생략하면 모두 허용합니다 (`false` 로 비활성화).
  - `reactions` (반응 + 반응 읽기 포함)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (채널 + 카테고리 + 권한 생성/편집/삭제)
  - `roles` (역할 추가/제거, 기본값 `false`)
  - `moderation` (타임아웃/킥/밴, 기본값 `false`)
  - `presence` (봇 상태/활동, 기본값 `false`)
- `execApprovals`: Discord 전용 exec 승인 다이렉트 메시지 (버튼 UI). `enabled`, `approvers`, `agentFilter`, `sessionFilter` 지원.

반응 알림은 `guilds.<id>.reactionNotifications` 을 사용합니다:

- `off`: 반응 이벤트 없음.
- `own`: 봇 자신의 메시지에 대한 반응 (기본값).
- `all`: 모든 메시지의 모든 반응.
- `allowlist`: `guilds.<id>.users` 의 반응만 모든 메시지에 적용 (빈 목록은 비활성화).

### PluralKit (PK) 지원

프록시 메시지가 기본 시스템 + 멤버로 해석되도록 PK 조회를 활성화합니다.
활성화되면 OpenClaw 는 허용 목록에 멤버 아이덴티티를 사용하고,
실수로 Discord 핑이 발생하지 않도록 발신자를 `Member (PK:System)` 로 표시합니다.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

허용 목록 참고 사항 (PK 활성화):

- `dm.allowFrom`, `guilds.<id>.users` 또는 채널별 `users` 에서 `pk:<memberId>` 를 사용하십시오.
- 멤버 표시 이름도 이름/슬러그로 매칭됩니다.
- 조회는 **원본** Discord 메시지 ID (프록시 이전 메시지) 를 사용하므로,
  PK API 는 30 분 창 내에서만 이를 해석합니다.
- PK 조회가 실패하면 (예: 토큰이 없는 비공개 시스템),
  프록시 메시지는 봇 메시지로 취급되어 `channels.discord.allowBots=true` 가 없는 한 드롭됩니다.

### 도구 액션 기본값

| 액션 그룹          | 기본값      | 참고 자료                                    |
| -------------- | -------- | ---------------------------------------- |
| reactions      | enabled  | 반응 + 반응 목록 + emojiList                   |
| stickers       | enabled  | 스티커 전송                                   |
| emojiUploads   | enabled  | Upload emojis                            |
| stickerUploads | enabled  | 스티커 업로드                                  |
| polls          | enabled  | 투표 생성                                    |
| permissions    | enabled  | 채널 권한 스냅샷                                |
| messages       | enabled  | 읽기/전송/편집/삭제                              |
| threads        | enabled  | 생성/목록/답글                                 |
| pins           | enabled  | 고정/해제/목록                                 |
| search         | enabled  | 메시지 검색 (미리보기 기능)      |
| memberInfo     | enabled  | 멤버 정보                                    |
| roleInfo       | enabled  | 역할 목록                                    |
| channelInfo    | enabled  | 채널 정보 + 목록                               |
| channels       | enabled  | 채널/카테고리 관리                               |
| voiceStatus    | enabled  | 음성 상태 조회                                 |
| events         | enabled  | 예약 이벤트 목록/생성                             |
| roles          | disabled | 역할 추가/제거                                 |
| moderation     | disabled | 타임아웃/킥/밴                                 |
| presence       | disabled | 봇 상태/활동 (setPresence) |

- `replyToMode`: `off` (기본값), `first`, 또는 `all`. 모델에 답글 태그가 포함된 경우에만 적용됩니다.

## 답글 태그

스레드 답글을 요청하려면 모델 출력에 하나의 태그를 포함할 수 있습니다:

- `[[reply_to_current]]` — 트리거된 Discord 메시지에 답글합니다.
- `[[reply_to:<id>]]` — 컨텍스트/히스토리의 특정 메시지 id 에 답글합니다.
  현재 메시지 id 는 `[message_id: …]` 로 프롬프트에 추가되며, 히스토리 항목에는 이미 id 가 포함되어 있습니다.

동작은 `channels.discord.replyToMode` 로 제어됩니다:

- `off`: 태그를 무시합니다.
- `first`: 첫 번째 아웃바운드 청크/첨부만 답글로 전송합니다.
- `all`: 모든 아웃바운드 청크/첨부를 답글로 전송합니다.

허용 목록 매칭 참고 사항:

- `allowFrom`/`users`/`groupChannels` 은 id, 이름, 태그 또는 `<@id>` 와 같은 멘션을 허용합니다.
- 사용자 접두사 `discord:`/`user:` 와 그룹 다이렉트 메시지 접두사 `channel:` 을 지원합니다.
- 모든 발신자/채널을 허용하려면 `*` 을 사용하십시오.
- `guilds.<id>.channels` 이 있으면 나열되지 않은 채널은 기본적으로 거부됩니다.
- `guilds.<id>.channels` 이 생략되면 허용 목록에 포함된 길드의 모든 채널이 허용됩니다.
- **어떤 채널도 허용하지 않으려면** `channels.discord.groupPolicy: "disabled"` 을 설정하십시오 (또는 빈 허용 목록 유지).
- 설정 마법사는 공개 및 비공개 `Guild/Channel` 이름을 받아 가능할 경우 ID 로 해석합니다.
- 시작 시 OpenClaw 는 허용 목록의 채널/사용자 이름을 ID 로 해석하고 (봇이 멤버를 검색할 수 있을 때)
  매핑을 로그에 기록합니다. 해석되지 않은 항목은 입력된 그대로 유지됩니다.

네이티브 명령 참고 사항:

- 등록된 명령은 OpenClaw 의 채팅 명령을 미러링합니다.
- 네이티브 명령은 다이렉트 메시지/길드 메시지와 동일한 허용 목록을 따릅니다 (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, 채널별 규칙).
- 슬래시 명령은 허용 목록에 없는 사용자에게도 Discord UI 에 표시될 수 있지만, 실행 시 OpenClaw 가 허용 목록을 강제하며 “권한 없음” 으로 응답합니다.

## 도구 액션

에이전트는 다음과 같은 액션으로 `discord` 를 호출할 수 있습니다:

- `react` / `reactions` (반응 추가 또는 목록)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- 읽기/검색/고정 도구 페이로드에는 원본 Discord `timestamp` 와 함께 정규화된 `timestampMs` (UTC epoch ms) 및 `timestampUtc` 이 포함됩니다.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (봇 활동 및 온라인 상태)

Discord 메시지 id 는 주입된 컨텍스트 (`[discord message id: …]` 및 히스토리 줄) 에 노출되어 에이전트가 이를 대상으로 지정할 수 있습니다.
이모지는 유니코드 (예: `✅`) 또는 `<:party_blob:1234567890>` 와 같은 커스텀 이모지 문법을 사용할 수 있습니다.

## 보안 및 운영

- 봇 토큰은 비밀번호처럼 취급하십시오. 감독되는 호스트에서는 `DISCORD_BOT_TOKEN` 환경 변수를 선호하거나 설정 파일 권한을 잠그십시오.
- 봇에 필요한 권한만 부여하십시오 (일반적으로 메시지 읽기/전송).
- 봇이 멈추었거나 레이트 리밋에 걸린 경우, 다른 프로세스가 Discord 세션을 소유하지 않는지 확인한 후 Gateway(게이트웨이) (`openclaw gateway --force`) 를 재시작하십시오.
