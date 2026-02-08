---
read_when:
    - Discord 채널 기능 작업 중
summary: Discord 봇 지원 상태, 기능 및 구성
title: 불화
x-i18n:
    generated_at: "2026-02-08T15:50:28Z"
    model: gtx
    provider: google-translate
    source_hash: 9bebfe8027ff197266b112c425e463771d92027ef8322c24df8c6e5a41666ec4
    source_path: channels/discord.md
    workflow: 15
---

# 디스코드(봇 API)

상태: 공식 Discord 봇 게이트웨이를 통해 DM 및 길드 텍스트 채널을 사용할 준비가 되었습니다.

## 빠른 설정(초보자)

1. Discord 봇을 생성하고 봇 토큰을 복사하세요.
2. Discord 앱 설정에서 활성화하세요. **메시지 내용 의도** (그리고 **서버 구성원 의도** 허용 목록이나 이름 조회를 사용하려는 경우).
3. OpenClaw용 토큰을 설정합니다.
   - 환경: `DISCORD_BOT_TOKEN=...`
   - 또는 구성: `channels.discord.token: "..."`.
   - 둘 다 설정된 경우 구성이 우선 적용됩니다(환경 대체는 기본 계정에만 해당).
4. 메시지 권한을 사용하여 봇을 서버에 초대하세요(DM만 원하는 경우 개인 서버를 만드세요).
5. 게이트웨이를 시작하십시오.
6. DM 액세스는 기본적으로 페어링됩니다. 첫 번째 연락 시 페어링 코드를 승인하세요.

최소 구성:

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

- Discord DM이나 길드 채널을 통해 OpenClaw와 대화하세요.
- 직접 채팅은 상담원의 기본 세션으로 축소됩니다(기본값 `agent:main:main`); 길드 채널은 다음과 같이 격리되어 있습니다. `agent:<agentId>:discord:channel:<channelId>` (표시 이름은 `discord:<guildSlug>#<channelSlug>`).
- 그룹 DM은 기본적으로 무시됩니다. 다음을 통해 활성화 `channels.discord.dm.groupEnabled` 선택적으로 다음으로 제한 `channels.discord.dm.groupChannels`.
- 라우팅을 결정적으로 유지하세요. 답변은 항상 도착한 채널로 돌아갑니다.

## 작동 원리

1. Discord 애플리케이션 → Bot을 만들고 필요한 인텐트(DM + 길드 메시지 + 메시지 콘텐츠)를 활성화하고 봇 토큰을 가져옵니다.
2. 사용하려는 메시지를 읽고 보내는 데 필요한 권한을 사용하여 봇을 서버에 초대하세요.
3. 다음으로 OpenClaw 구성 `channels.discord.token` (또는 `DISCORD_BOT_TOKEN` 대체적으로).
4. 게이트웨이를 실행하십시오. 토큰을 사용할 수 있을 때(먼저 구성, 환경 폴백) Discord 채널을 자동으로 시작하고 `channels.discord.enabled` 아니다 `false`.
   - 환경 변수를 선호하는 경우 다음을 설정하세요. `DISCORD_BOT_TOKEN` (구성 블록은 선택 사항입니다).
5. 직접 채팅: 사용 `user:<id>` (또는 `<@id>` 언급) 배송시; 모든 것이 공유지에 착륙하게 됩니다 `main` 세션. 단순한 숫자 ID는 모호하며 거부됩니다.
6. 길드 채널: 사용 `channel:<channelId>` 배달을 위해. 멘션은 기본적으로 필수사항이며 길드별, 채널별로 설정할 수 있습니다.
7. 직접 채팅: 기본적으로 다음을 통해 보안됩니다. `channels.discord.dm.policy` (기본: `"pairing"`). 알 수 없는 발신자는 페어링 코드를 받습니다(1시간 후에 만료됨). 다음을 통해 승인 `openclaw pairing approve discord <code>`.
   - 이전의 "누구에게나 공개" 동작을 유지하려면 다음을 설정하세요. `channels.discord.dm.policy="open"` 그리고 `channels.discord.dm.allowFrom=["*"]`.
   - 하드 허용 목록에: 설정 `channels.discord.dm.policy="allowlist"` 발신자를 나열합니다. `channels.discord.dm.allowFrom`.
   - 모든 DM을 무시하려면: 설정 `channels.discord.dm.enabled=false` 또는 `channels.discord.dm.policy="disabled"`.
8. 그룹 DM은 기본적으로 무시됩니다. 다음을 통해 활성화 `channels.discord.dm.groupEnabled` 선택적으로 다음으로 제한 `channels.discord.dm.groupChannels`.
9. 선택적 길드 규칙: 설정 `channels.discord.guilds` 채널별 규칙에 따라 길드 ID(선호) 또는 슬러그로 입력됩니다.
10. 선택적 기본 명령: `commands.native` 기본값은 `"auto"` (Discord/Telegram의 경우 켜짐, Slack의 경우 꺼짐) 다음으로 재정의 `channels.discord.commands.native: true|false|"auto"`; `false` 이전에 등록된 명령을 지웁니다. 텍스트 명령은 다음에 의해 제어됩니다. `commands.text` 독립형으로 보내야 합니다. `/...` 메시지. 사용 `commands.useAccessGroups: false` 명령에 대한 액세스 그룹 검사를 우회합니다.
    - 전체 명령 목록 + 구성: [슬래시 명령](/tools/slash-commands)
11. 선택적 길드 상황 기록: 설정 `channels.discord.historyLimit` (기본값은 20, 다음으로 대체됩니다. `messages.groupChat.historyLimit`) 멘션에 응답할 때 마지막 N개의 길드 메시지를 컨텍스트로 포함합니다. 세트 `0` 비활성화합니다.
12. 반응: 에이전트는 다음을 통해 반응을 유발할 수 있습니다. `discord` 도구(게이트 `channels.discord.actions.*`).
    - 반응 제거 의미: 참조 [/도구/반응](/tools/reactions).
    - 그만큼 `discord` 도구는 현재 채널이 디스코드일 때만 노출됩니다.
13. 기본 명령은 격리된 세션 키(`agent:<agentId>:discord:slash:<userId>`) 공유보다는 `main` 세션.

참고: 이름 → ID 확인은 길드원 검색을 사용하며 서버 회원 의도가 필요합니다. 봇이 회원을 검색할 수 없는 경우 ID를 사용하거나 `<@id>` 언급합니다.
참고: 슬러그는 소문자이며 공백은 다음으로 대체됩니다. `-`. 채널 이름이 선행 없이 슬러그됩니다. `#`.
참고: 길드 상황 `[from:]` 라인에는 다음이 포함됩니다 `author.tag` + `id` 핑 준비 응답을 쉽게 만들 수 있습니다.

## 구성 쓰기

기본적으로 Discord는 다음에 의해 트리거되는 구성 업데이트를 작성할 수 있습니다. `/config set|unset` (요구 `commands.config: true`).

다음을 사용하여 비활성화:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## 나만의 봇을 만드는 방법

다음과 같은 서버(길드) 채널에서 OpenClaw를 실행하기 위한 “Discord 개발자 포털” 설정입니다. `#help`.

### 1) Discord 앱 + 봇 사용자 생성

1. Discord 개발자 포털 → **응용** → **새로운 애플리케이션**
2. 앱에서:
   - **봇** → **봇 추가**
   - 복사 **봇 토큰** (이것은 당신이 넣은 것입니다 `DISCORD_BOT_TOKEN`)

### 2) OpenClaw에 필요한 게이트웨이 의도 활성화

Discord는 명시적으로 활성화하지 않는 한 '특권 의도'를 차단합니다.

~ 안에 **봇** → **권한 있는 게이트웨이 인텐트**, 할 수 있게 하다:

- **메시지 내용 의도** (대부분의 길드에서 메시지 텍스트를 읽는 데 필요합니다. 이를 읽지 않으면 "허용되지 않는 의도 사용"이 표시되거나 봇이 연결되지만 메시지에 반응하지 않습니다)
- **서버 구성원 의도** (권장; 일부 회원/사용자 조회 및 길드 허용 목록 매칭에 필요)

당신은 보통 **~ 아니다** 필요 **존재 의도**. 봇의 존재 여부 설정(`setPresence` 작업) 게이트웨이 OP3을 사용하며 이 의도가 필요하지 않습니다. 다른 길드원에 대한 최신 소식을 받고 싶은 경우에만 필요합니다.

### 3) 초대 URL 생성(OAuth2 URL 생성기)

앱에서:**OAuth2** → **URL 생성기**

**범위**

- ✅ `bot`
- ✅ `applications.commands` (기본 명령에 필요)

**봇 권한** (최소 기준선)

- ✅ 채널 보기
- ✅ 메시지 보내기
- ✅ 메시지 기록 읽기
- ✅ 링크 삽입
- ✅ 파일 첨부
- ✅ 반응 추가(선택 사항이지만 권장됨)
- ✅ 외부 이모티콘/스티커 사용(선택 사항, 원하는 경우에만)

피하다 **관리자** 디버깅 중이고 봇을 완전히 신뢰하지 않는 한.

생성된 URL을 복사하여 열고 서버를 선택한 후 봇을 설치하세요.

### 4) ID 가져오기(길드/유저/채널)

Discord는 어디에서나 숫자 ID를 사용합니다. OpenClaw 구성은 ID를 선호합니다.

1. 디스코드(데스크톱/웹) → **사용자 설정** → **고급의** → 활성화 **개발자 모드**
2. 오른쪽 클릭:
   - 서버 이름 → **서버 ID 복사** (길드 아이디)
   - 채널(예: `#help`) → **채널 ID 복사**
   - 귀하의 사용자 → **사용자 ID 복사**

### 5) OpenClaw 구성

#### 토큰

env var를 통해 봇 토큰을 설정합니다(서버에서 권장).

- `DISCORD_BOT_TOKEN=...`

또는 구성을 통해:

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

다중 계정 지원: 사용 `channels.discord.accounts` 계정별 토큰 및 선택 사항 포함 `name`. 보다 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 공유 패턴의 경우.

#### 허용 목록 + 채널 라우팅

예: "단일 서버, 나만 허용, #help만 허용":

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

참고:

- `requireMention: true` 봇은 언급된 경우에만 응답함을 의미합니다(공유 채널에 권장).
- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`) 또한 길드 메시지에 대한 멘션으로 간주됩니다.
- 다중 에이전트 재정의: 에이전트별 패턴 설정 `agents.list[].groupChat.mentionPatterns`.
- 만약에 `channels` 표시되지 않은 채널은 기본적으로 거부됩니다.
- 사용 `"*"` 모든 채널에 걸쳐 기본값을 적용하는 채널 항목 명시적 채널 항목은 와일드카드를 재정의합니다.
- 스레드는 상위 채널 구성(허용 목록, `requireMention`, 스킬, 프롬프트 등) 스레드 채널 ID를 명시적으로 추가하지 않는 한.
- 소유자 힌트: 길드별 또는 채널별 `users` 허용 목록이 보낸 사람과 일치하면 OpenClaw는 시스템 프롬프트에서 해당 보낸 사람을 소유자로 처리합니다. 채널 전반에 걸친 전역 소유자의 경우 다음을 설정합니다. `commands.ownerAllowFrom`.
- 봇이 작성한 메시지는 기본적으로 무시됩니다. 세트 `channels.discord.allowBots=true` 허용합니다(자신의 메시지는 필터링된 상태로 유지됩니다).
- 경고: 다른 봇에 대한 답장을 허용하는 경우(`channels.discord.allowBots=true`), 다음을 사용하여 봇 간 응답 루프를 방지합니다. `requireMention`, `channels.discord.guilds.*.channels.<id>.users` 허용 목록 및/또는 명확한 가드레일 `AGENTS.md` 그리고 `SOUL.md`.

### 6) 작동하는지 확인

1. 게이트웨이를 시작하십시오.
2. 서버 채널에서 다음을 보냅니다. `@Krill hello` (또는 봇 이름이 무엇이든).
3. 아무 일도 일어나지 않으면: 확인하세요 **문제 해결** 아래에.

### 문제 해결

- 첫 번째: 실행 `openclaw doctor` 그리고 `openclaw channels status --probe` (실행 가능한 경고 + 빠른 감사)
- **"허용되지 않는 의도를 사용했습니다"**: 할 수 있게 하다 **메시지 내용 의도** (아마도 **서버 구성원 의도**) 개발자 포털에서 게이트웨이를 다시 시작하세요.
- **봇이 연결되지만 길드 채널에서 응답하지 않습니다.**:
  - 없어진 **메시지 내용 의도**, 또는
  - 봇에 채널 권한(기록 보기/보내기/읽기)이 부족하거나
  - 구성에 언급이 필요하지만 언급하지 않았거나
  - 귀하의 길드/채널 허용 목록이 해당 채널/사용자를 거부합니다.
- **`requireMention: false` 근데 아직도 답장이 없어**:
- `channels.discord.groupPolicy` 기본값은 **허용 목록**; 으로 설정하다 `"open"` 또는 아래에 길드 항목을 추가하세요. `channels.discord.guilds` (선택적으로 아래에 채널을 나열합니다. `channels.discord.guilds.<id>.channels` 제한합니다).
  - 설정만 하면 `DISCORD_BOT_TOKEN` 절대 만들지 마세요. `channels.discord` 섹션, 런타임
    기본값 `groupPolicy` 에게 `open`. 추가하다 `channels.discord.groupPolicy`, 
    `channels.defaults.groupPolicy`, 또는 길드/채널 허용 목록을 사용하여 잠글 수 있습니다.
- `requireMention` 아래에서 살아야 한다 `channels.discord.guilds` (또는 특정 채널). `channels.discord.requireMention` 최상위 수준에서는 무시됩니다.
- **권한 감사** (`channels status --probe`) 숫자로 된 채널 ID만 확인하세요. 슬러그/이름을 다음과 같이 사용하는 경우 `channels.discord.guilds.*.channels` 키가 없으면 감사에서 권한을 확인할 수 없습니다.
- **DM이 작동하지 않습니다**:`channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, 또는 아직 승인되지 않았습니다(`channels.discord.dm.policy="pairing"`).
- **Discord의 임원 승인**: Discord는 다음을 지원합니다. **버튼 UI** DM의 실행 승인을 위해(한 번 허용/항상 허용/거부) `/approve <id> ...` 전달된 승인에만 해당되며 Discord의 버튼 프롬프트는 해결되지 않습니다. 당신이 본다면 `❌ Failed to submit approval: Error: unknown approval id` 그렇지 않으면 UI가 표시되지 않습니다. 다음을 확인하세요.
  - `channels.discord.execApprovals.enabled: true` 귀하의 구성에서.
  - 귀하의 Discord 사용자 ID는 다음 위치에 나열되어 있습니다. `channels.discord.execApprovals.approvers` (UI는 승인자에게만 전송됩니다.)
  - DM 프롬프트의 버튼을 사용합니다(**한 번만 허용**, **항상 허용**, **부인하다**).
  - 보다 [임원 승인](/tools/exec-approvals) 그리고 [슬래시 명령](/tools/slash-commands) 더 광범위한 승인 및 명령 흐름을 위해.

## 기능 및 한계

- DM 및 길드 텍스트 채널(스레드는 별도의 채널로 처리되며 음성은 지원되지 않음)
- 입력 표시기는 최선을 다해 전송되었습니다. 메시지 청킹 사용 `channels.discord.textChunkLimit` (기본값 2000) 긴 응답을 줄 수로 분할합니다(`channels.discord.maxLinesPerMessage`, 기본값은 17).
- 선택적 개행 청킹: 설정 `channels.discord.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- 구성된 최대 파일 업로드 지원 `channels.discord.mediaMaxMb` (기본값 8MB)
- 시끄러운 봇을 피하기 위해 멘션 게이트 길드가 기본적으로 응답합니다.
- 메시지가 다른 메시지(인용된 콘텐츠 + ID)를 참조할 때 응답 컨텍스트가 삽입됩니다.
- 기본 응답 스레딩은 **기본적으로 꺼짐**; 활성화 `channels.discord.replyToMode` 그리고 답장 태그.

## 재시도 정책

아웃바운드 Discord API 호출은 Discord를 사용하여 속도 제한(429)에 대해 재시도합니다. `retry_after` 가능한 경우 지수 백오프 및 지터를 사용합니다. 다음을 통해 구성 `channels.discord.retry`. 보다 [재시도 정책](/concepts/retry).

## 구성

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

Ack 반응은 다음을 통해 전역적으로 제어됩니다. `messages.ackReaction` + 
`messages.ackReactionScope`. 사용 `messages.removeAckAfterReply` 지우기 위해
봇이 응답한 후 ack 반응입니다.

- `dm.enabled`: 세트 `false` 모든 DM을 무시하려면(기본값 `true`).
- `dm.policy`: DM접근제어(`pairing` 권장). `"open"` 필요하다 `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM 허용 목록(사용자 ID 또는 이름). 사용처 `dm.policy="allowlist"` 그리고 `dm.policy="open"` 확인. 마법사는 사용자 이름을 수락하고 봇이 구성원을 검색할 수 있을 때 이를 ID로 확인합니다.
- `dm.groupEnabled`: 그룹 DM 활성화(기본값 `false`).
- `dm.groupChannels`: 그룹 DM 채널 ID 또는 슬러그에 대한 선택적 허용 목록입니다.
- `groupPolicy`: 길드 채널 처리를 제어합니다(`open|disabled|allowlist`); `allowlist` 채널 허용 목록이 필요합니다.
- `guilds`: 길드 ID(선호) 또는 슬러그를 기준으로 한 길드별 규칙입니다.
- `guilds."*"`: 명시적인 항목이 없을 때 길드별 기본 설정이 적용됩니다.
- `guilds.<id>.slug`: 표시 이름에 사용되는 선택적 친숙한 슬러그입니다.
- `guilds.<id>.users`: 길드별 사용자 허용 목록(ID 또는 이름)은 선택사항입니다.
- `guilds.<id>.tools`: 선택적인 길드별 도구 정책 재정의(`allow`/`deny`/`alsoAllow`) 채널 재정의가 누락되었을 때 사용됩니다.
- `guilds.<id>.toolsBySender`: 길드 수준에서 선택적 발신자별 도구 정책 재정의(채널 재정의가 누락된 경우 적용됩니다. `"*"` 와일드카드 지원).
- `guilds.<id>.channels.<channel>.allow`: 다음과 같은 경우 채널을 허용/거부합니다. `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: 채널에 대한 게이팅을 언급합니다.
- `guilds.<id>.channels.<channel>.tools`: 선택적인 채널별 도구 정책 재정의(`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: 채널 내에서 선택적 발신자별 도구 정책 재정의(`"*"` 와일드카드 지원).
- `guilds.<id>.channels.<channel>.users`: 선택적인 채널별 사용자 허용 목록입니다.
- `guilds.<id>.channels.<channel>.skills`: 스킬 필터(생략 = 모든 스킬, 비어 있음 = 없음).
- `guilds.<id>.channels.<channel>.systemPrompt`: 채널에 대한 추가 시스템 프롬프트입니다. Discord 채널 주제는 다음과 같이 주입됩니다. **신뢰할 수 없는** 컨텍스트(시스템 프롬프트 아님)
- `guilds.<id>.channels.<channel>.enabled`: 세트 `false` 채널을 비활성화합니다.
- `guilds.<id>.channels`: 채널 규칙(키는 채널 슬러그 또는 ID입니다).
- `guilds.<id>.requireMention`: 길드별 언급 요구 사항(채널별로 재정의 가능)
- `guilds.<id>.reactionNotifications`: 반응 시스템 이벤트 모드(`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: 아웃바운드 텍스트 청크 크기(문자)입니다. 기본값: 2000.
- `chunkMode`:`length` (기본값) 초과하는 경우에만 분할 `textChunkLimit`; `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할됩니다.
- `maxLinesPerMessage`: 메시지당 소프트 최대 줄 수입니다. 기본값: 17.
- `mediaMaxMb`: 디스크에 저장된 인바운드 미디어를 클램프합니다.
- `historyLimit`: 멘션에 응답할 때 컨텍스트로 포함할 최근 길드 메시지 수(기본값 20, 대체 `messages.groupChat.historyLimit`; `0` 비활성화).
- `dmHistoryLimit`: 사용자 턴의 DM 기록 제한입니다. 사용자별 재정의: `dms["<user_id>"].historyLimit`.
- `retry`: 아웃바운드 Discord API 호출(시도, minDelayMs, maxDelayMs, jitter)에 대한 재시도 정책입니다.
- `pluralkit`: 시스템 구성원이 별개의 발신자로 표시되도록 PluralKit 프록시 메시지를 해결합니다.
- `actions`: 작업별 도구 게이트; 모두 허용하려면 생략(설정 `false` 비활성화합니다).
  - `reactions` (반응 + 읽기 반응을 다룹니다)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (채널 + 카테고리 + 권한 생성/수정/삭제)
  - `roles` (역할 추가/제거, 기본값 `false`)
  - `moderation` (타임아웃/킥/금지, 기본값 `false`)
  - `presence` (봇 상태/활동, 기본값 `false`)
- `execApprovals`: Discord 전용 임원 승인 DM(버튼 UI). 지원 `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

반응 알림 사용 `guilds.<id>.reactionNotifications`:

- `off`: 반응 이벤트가 없습니다.
- `own`: 봇 자체 메시지에 대한 반응(기본값)
- `all`: 모든 메시지에 대한 모든 반응.
- `allowlist`: 반응 `guilds.<id>.users` 모든 메시지에 적용됩니다(빈 목록은 비활성화됩니다).

### PluralKit(PK) 지원

프록시된 메시지가 기본 시스템 + 구성원으로 확인되도록 PK 조회를 활성화합니다.
활성화되면 OpenClaw는 허용 목록에 대한 구성원 ID를 사용하고 해당 항목에 레이블을 지정합니다.
발신자 `Member (PK:System)` 실수로 Discord 핑이 발생하는 것을 방지합니다.

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

허용 목록 메모(PK 사용):

- 사용 `pk:<memberId>` ~에 `dm.allowFrom`, `guilds.<id>.users`또는 채널당 `users`.
- 멤버 표시 이름은 이름/슬러그와도 일치합니다.
- 조회는 다음을 사용합니다. **원래의** Discord 메시지 ID(사전 프록시 메시지)이므로
  PK API는 30분 이내에만 문제를 해결합니다.
- PK 조회가 실패하는 경우(예: 토큰이 없는 개인 시스템) 프록시된 메시지
  봇 메시지로 처리되며 다음과 같은 경우가 아니면 삭제됩니다. `channels.discord.allowBots=true`.

### 도구 작업 기본값

| Action group   | Default  | Notes                              |
| -------------- | -------- | ---------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList |
| stickers       | enabled  | Send stickers                      |
| emojiUploads   | enabled  | Upload emojis                      |
| stickerUploads | enabled  | Upload stickers                    |
| polls          | enabled  | Create polls                       |
| permissions    | enabled  | Channel permission snapshot        |
| messages       | enabled  | Read/send/edit/delete              |
| threads        | enabled  | Create/list/reply                  |
| pins           | enabled  | Pin/unpin/list                     |
| search         | enabled  | Message search (preview feature)   |
| memberInfo     | enabled  | Member info                        |
| roleInfo       | enabled  | Role list                          |
| channelInfo    | enabled  | Channel info + list                |
| channels       | enabled  | Channel/category management        |
| voiceStatus    | enabled  | Voice state lookup                 |
| events         | enabled  | List/create scheduled events       |
| roles          | disabled | Role add/remove                    |
| moderation     | disabled | Timeout/kick/ban                   |
| presence       | disabled | Bot status/activity (setPresence)  |

- `replyToMode`:`off` (기본), `first`, 또는`all`. 모델에 응답 태그가 포함된 경우에만 적용됩니다.

## 답장 태그

스레드 응답을 요청하기 위해 모델은 출력에 하나의 태그를 포함할 수 있습니다.

- `[[reply_to_current]]` — 트리거된 Discord 메시지에 답장하세요.
- `[[reply_to:<id>]]` — 컨텍스트/기록에서 특정 메시지 ID에 응답합니다.
  현재 메시지 ID는 다음과 같이 프롬프트에 추가됩니다. `[message_id: …]`; 기록 항목에는 이미 ID가 포함되어 있습니다.

행동은 다음에 의해 제어됩니다. `channels.discord.replyToMode`:

- `off`: 태그를 무시합니다.
- `first`: 첫 번째 아웃바운드 청크/첨부 파일만 응답입니다.
- `all`: 모든 아웃바운드 청크/첨부 파일은 응답입니다.

허용 목록 일치 참고사항:

- `allowFrom`/`users`/`groupChannels` ID, 이름, 태그 또는 다음과 같은 언급을 허용합니다. `<@id>`.
- 다음과 같은 접두사 `discord:`/`user:` (사용자) 및 `channel:` (그룹 DM)이 지원됩니다.
- 사용 `*` 모든 발신자/채널을 허용합니다.
- 언제 `guilds.<id>.channels` 이 있으면 목록에 없는 채널은 기본적으로 거부됩니다.
- 언제 `guilds.<id>.channels` 생략 시 허용된 길드의 모든 채널을 허용합니다.
- 허용하려면 **채널 없음**, 세트 `channels.discord.groupPolicy: "disabled"` (또는 빈 허용 목록을 유지하세요)
- 구성 마법사가 수락합니다. `Guild/Channel` 이름(공개 + 비공개)을 확인하고 가능한 경우 이를 ID로 확인합니다.
- 시작 시 OpenClaw는 허용 목록의 채널/사용자 이름을 ID로 확인합니다(봇이 구성원을 검색할 수 있는 경우).
  매핑을 기록합니다. 해결되지 않은 항목은 입력한 대로 유지됩니다.

기본 명령 참고 사항:

- 등록된 명령어는 OpenClaw의 채팅 명령어를 반영합니다.
- 기본 명령은 DM/길드 메시지와 동일한 허용 목록을 준수합니다(`channels.discord.dm.allowFrom`, `channels.discord.guilds`, 채널별 규칙).
- 허용 목록에 포함되지 않은 사용자에게는 슬래시 명령이 Discord UI에 계속 표시될 수 있습니다. OpenClaw는 실행 시 허용 목록을 적용하고 "승인되지 않음"이라고 응답합니다.

## 도구 작업

상담원이 전화할 수 있습니다. `discord` 다음과 같은 작업을 수행합니다.

- `react`/`reactions` (반응 추가 또는 나열)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- 읽기/검색/고정 도구 페이로드에는 정규화된 항목이 포함됩니다. `timestampMs` (UTC epoch ms) 및 `timestampUtc` 원시 Discord와 함께 `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (봇 활동 및 온라인 상태)

Discord 메시지 ID는 삽입된 컨텍스트(`[discord message id: …]` 및 내역 라인) 에이전트가 이를 타겟팅할 수 있도록 합니다.
이모티콘은 유니코드일 수 있습니다(예: `✅`) 또는 다음과 같은 맞춤 이모티콘 구문 `<:party_blob:1234567890>`.

## 안전 및 운영

- 봇 토큰을 비밀번호처럼 취급하세요. 선호하다 `DISCORD_BOT_TOKEN` 감독되는 호스트의 env var 또는 구성 파일 권한을 잠급니다.
- 필요한 봇 권한(일반적으로 메시지 읽기/보내기)만 부여하세요.
- 봇이 멈추거나 속도가 제한된 경우 게이트웨이를 다시 시작합니다(`openclaw gateway --force`) Discord 세션을 소유한 다른 프로세스가 없음을 확인한 후.
