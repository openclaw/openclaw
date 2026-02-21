---
summary: "Discord 봇 지원 상태, 기능 및 설정"
read_when:
  - Discord 채널 기능 작업 시
title: "Discord"
---

# Discord (Bot API)

Status: 공식 Discord 게이트웨이를 통해 다이렉트 메시지와 길드 채널을 사용할 준비가 완료되었습니다.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/ko-KR/channels/pairing">
    Discord 다이렉트 메시지는 기본적으로 페어링 모드입니다.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/ko-KR/tools/slash-commands">
    네이티브 명령어 동작 및 명령어 카탈로그.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/ko-KR/channels/troubleshooting">
    교차 채널 진단 및 수리 흐름.
  </Card>
</CardGroup>

## 빠른 설정

봇이 있는 새 애플리케이션을 생성하고, 봇을 서버에 추가한 후 OpenClaw와 페어링해야 합니다. 봇을 자신의 비공개 서버에 추가하는 것을 권장합니다. 아직 없다면 [먼저 서버를 생성하세요](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server) (**Create My Own > For me and my friends** 선택).

<Steps>
  <Step title="Discord 애플리케이션 및 봇 생성">
    [Discord 개발자 포털](https://discord.com/developers/applications)에서 **New Application**을 클릭합니다. "OpenClaw"와 같은 이름을 붙이세요.

    사이드바에서 **Bot**을 클릭합니다. **Username**을 OpenClaw 에이전트 이름으로 설정하세요.

  </Step>

  <Step title="특권 인텐트 활성화">
    **Bot** 페이지에서 아래로 스크롤하여 **Privileged Gateway Intents**를 활성화합니다:

    - **Message Content Intent** (필수)
    - **Server Members Intent** (권장; 역할 허용 목록 및 이름-to-ID 매칭에 필수)
    - **Presence Intent** (선택; 프레즌스 업데이트가 필요한 경우에만)

  </Step>

  <Step title="봇 토큰 복사">
    **Bot** 페이지 위로 스크롤하여 **Reset Token**을 클릭합니다.

    <Note>
    이름과 달리, 이 작업은 첫 번째 토큰을 생성합니다 — 실제로 "재설정"되는 것은 없습니다.
    </Note>

    토큰을 복사하여 저장하세요. 이것이 **봇 토큰**으로 곧 필요합니다.

  </Step>

  <Step title="초대 URL 생성 및 봇을 서버에 추가">
    사이드바에서 **OAuth2**를 클릭합니다. 봇을 서버에 추가하기 위한 초대 URL을 생성합니다.

    **OAuth2 URL Generator**로 스크롤하여 활성화합니다:

    - `bot`
    - `applications.commands`

    아래에 **Bot Permissions** 섹션이 나타납니다. 다음을 활성화하세요:

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions (선택)

    하단의 생성된 URL을 복사하여 브라우저에 붙여넣고, 서버를 선택한 후 **Continue**를 클릭하여 연결합니다. 이제 Discord 서버에서 봇을 확인할 수 있습니다.

  </Step>

  <Step title="개발자 모드 활성화 및 ID 수집">
    Discord 앱에서 내부 ID를 복사할 수 있도록 개발자 모드를 활성화해야 합니다.

    1. **User Settings** (아바타 옆 기어 아이콘) → **Advanced** → **Developer Mode** 켜기
    2. 사이드바의 **서버 아이콘**을 우클릭 → **Copy Server ID**
    3. **자신의 아바타**를 우클릭 → **Copy User ID**

    **서버 ID**와 **사용자 ID**를 봇 토큰과 함께 저장하세요 — 다음 단계에서 OpenClaw에 세 가지 모두 전달합니다.

  </Step>

  <Step title="서버 멤버의 DM 허용">
    페어링이 작동하려면 Discord에서 봇이 DM을 보낼 수 있어야 합니다. **서버 아이콘**을 우클릭 → **Privacy Settings** → **Direct Messages**를 켜세요.

    이렇게 하면 서버 멤버(봇 포함)가 DM을 보낼 수 있습니다. OpenClaw와 Discord DM을 사용하려면 이 설정을 켜둬야 합니다. 길드 채널만 사용할 계획이라면 페어링 후 DM을 비활성화할 수 있습니다.

  </Step>

  <Step title="0단계: 봇 토큰 안전하게 설정 (채팅으로 전송하지 마세요)">
    Discord 봇 토큰은 비밀(패스워드 같은 것)입니다. 에이전트에게 메시지를 보내기 전에 OpenClaw가 실행 중인 기기에 설정하세요.

```bash
openclaw config set channels.discord.token '"YOUR_BOT_TOKEN"' --json
openclaw config set channels.discord.enabled true --json
openclaw gateway
```

    OpenClaw가 이미 백그라운드 서비스로 실행 중이라면 대신 `openclaw gateway restart`를 사용하세요.

  </Step>

  <Step title="OpenClaw 설정 및 페어링">

    <Tabs>
      <Tab title="에이전트에게 요청">
        기존 채널(예: Telegram)에서 OpenClaw 에이전트와 채팅하여 알려주세요. Discord가 첫 번째 채널이라면 CLI / 설정 탭을 사용하세요.

        > "Discord 봇 토큰을 config에 이미 설정했습니다. 사용자 ID `<user_id>`와 서버 ID `<server_id>`로 Discord 설정을 완료해 주세요."
      </Tab>
      <Tab title="CLI / 설정">
        파일 기반 설정을 선호하는 경우 다음을 설정하세요:

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

        기본 계정의 환경 변수 대체:

```bash
DISCORD_BOT_TOKEN=...
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="첫 번째 DM 페어링 승인">
    게이트웨이가 실행 중일 때까지 기다린 후 Discord에서 봇에게 DM을 보내세요. 봇이 페어링 코드로 응답합니다.

    <Tabs>
      <Tab title="에이전트에게 요청">
        기존 채널에서 에이전트에게 페어링 코드를 전달하세요:

        > "이 Discord 페어링 코드를 승인해 주세요: `<CODE>`"
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    페어링 코드는 1시간 후 만료됩니다.

    이제 Discord DM을 통해 에이전트와 채팅할 수 있습니다.

  </Step>
</Steps>

<Note>
토큰 해상도는 계정 인식이 가능합니다. 설정 토큰 값이 환경 변수 대체보다 우선합니다. `DISCORD_BOT_TOKEN`은 기본 계정에만 사용됩니다.
</Note>

## 권장: 길드 워크스페이스 설정

DM이 작동하면 Discord 서버를 각 채널이 자체 컨텍스트를 가진 에이전트 세션으로 전체 워크스페이스로 설정할 수 있습니다. 봇과 여러분만 있는 비공개 서버에 권장됩니다.

<Steps>
  <Step title="길드 허용 목록에 서버 추가">
    이렇게 하면 에이전트가 DM뿐만 아니라 서버의 모든 채널에서 응답할 수 있습니다.

    <Tabs>
      <Tab title="에이전트에게 요청">
        > "Discord 서버 ID `<server_id>`를 길드 허용 목록에 추가해 주세요"
      </Tab>
      <Tab title="설정">

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="@멘션 없이 응답 허용">
    기본적으로 에이전트는 @멘션 시에만 길드 채널에서 응답합니다. 비공개 서버의 경우 모든 메시지에 응답하게 설정하는 것이 편리합니다.

    <Tabs>
      <Tab title="에이전트에게 요청">
        > "이 서버에서 @멘션 없이도 에이전트가 응답하도록 해 주세요"
      </Tab>
      <Tab title="설정">
        길드 설정에서 `requireMention: false`로 설정하세요:

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: false,
        },
      },
    },
  },
}
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="길드 채널에서의 메모리 계획">
    기본적으로 장기 메모리(MEMORY.md)는 DM 세션에서만 로드됩니다. 길드 채널은 MEMORY.md를 자동으로 로드하지 않습니다.

    <Tabs>
      <Tab title="에이전트에게 요청">
        > "Discord 채널에서 질문할 때 MEMORY.md에서 장기 컨텍스트가 필요하면 memory_search나 memory_get을 사용해 주세요."
      </Tab>
      <Tab title="수동">
        모든 채널에서 공유 컨텍스트가 필요하다면 안정적인 지침을 `AGENTS.md` 또는 `USER.md`에 넣으세요 (모든 세션에 주입됩니다). 장기 메모를 `MEMORY.md`에 저장하고 메모리 도구를 통해 필요할 때 접근하세요.
      </Tab>
    </Tabs>

  </Step>
</Steps>

Discord 서버에 채널을 만들고 채팅을 시작하세요. 에이전트는 채널 이름을 볼 수 있으며, 각 채널은 자체 격리 세션을 가집니다 — `#코딩`, `#홈`, `#연구` 등 워크플로우에 맞는 채널을 설정할 수 있습니다.

## Runtime model

- 게이트웨이는 Discord 연결을 소유합니다.
- 응답 라우팅은 결정론적입니다: Discord로부터 받은 응답은 다시 Discord로 돌아갑니다.
- 기본적으로 (`session.dmScope=main`), 직접 채팅은 에이전트의 메인 세션을 공유합니다 (`agent:main:main`).
- 길드 채널은 격리된 세션 키입니다 (`agent:<agentId>:discord:channel:<channelId>`).
- 그룹 다이렉트 메시지는 기본적으로 무시됩니다 (`channels.discord.dm.groupEnabled=false`).
- 네이티브 슬래시 명령어는 격리된 명령어 세션 (`agent:<agentId>:discord:slash:<userId>`)에서 실행되며, `CommandTargetSessionKey`를 경로화된 대화 세션에 유지합니다.

## 포럼 채널

Discord 포럼 및 미디어 채널은 스레드 게시물만 허용합니다. OpenClaw는 두 가지 방법으로 이를 생성합니다:

- 포럼 상위 채널(`channel:<forumId>`)로 메시지를 보내면 자동으로 스레드가 생성됩니다. 스레드 제목은 메시지의 첫 번째 비어있지 않은 줄을 사용합니다.
- `openclaw message thread create`를 사용하여 직접 스레드를 생성합니다. 포럼 채널에는 `--message-id`를 전달하지 마세요.

예시: 포럼 상위 채널에 보내서 스레드 생성

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "토픽 제목\n게시물 본문"
```

예시: 포럼 스레드 명시적 생성

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "토픽 제목" --message "게시물 본문"
```

포럼 상위 채널은 Discord 컴포넌트를 허용하지 않습니다. 컴포넌트가 필요하다면 스레드 자체(`channel:<threadId>`)로 보내세요.

## Interactive components

OpenClaw는 에이전트 메시지에 대해 Discord components v2 컨테이너를 지원합니다. 메시지 도구를 `components` 페이로드로 사용하세요. 상호작용 결과는 기존 Discord `replyToMode` 설정을 따라 정상적인 인바운드 메시지로 에이전트에게 라우팅됩니다.

지원 블록:

- `text`, `section`, `separator`, `actions`, `media-gallery`, `file`
- 액션 행은 최대 5개의 버튼 또는 단일 선택 메뉴를 허용합니다
- 선택 유형: `string`, `user`, `role`, `mentionable`, `channel`

기본적으로 컴포넌트는 단일 사용입니다. `components.reusable=true`로 버튼, 선택, 및 양식을 만료될 때까지 여러 번 사용할 수 있도록 설정하세요.

누가 버튼을 클릭할 수 있는지를 제한하려면 해당 버튼에 `allowedUsers`를 설정하세요 (Discord 사용자 ID, 태그 또는 `*`). 구성된 경우 매치되지 않는 사용자는 에페멀로 거부를 받습니다.

`/model` 및 `/models` 슬래시 명령어는 프로바이더와 모델 드롭다운 및 제출 단계가 있는 인터랙티브 모델 선택기를 엽니다. 선택기 응답은 에페멀이며 호출한 사용자만 사용할 수 있습니다.

파일 첨부:

- `file` 블록은 첨부 파일 참조 (`attachment://<filename>`)를 가리켜야 합니다
- `media`/`path`/`filePath`를 통해 첨부 파일을 제공하세요 (단일 파일); 여러 파일의 경우 `media-gallery`를 사용하세요
- 첨부 파일 참조와 일치해야 하는 경우 업로드 이름을 덮어쓰려면 `filename`을 사용하세요

모달 폼:

- 최대 5개의 필드로 `components.modal`을 추가하세요
- 필드 유형: `text`, `checkbox`, `radio`, `select`, `role-select`, `user-select`
- OpenClaw는 자동으로 트리거 버튼을 추가합니다

예시:

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.discord.dmPolicy`는 다이렉트 메시지 접근을 제어합니다 (레거시: `channels.discord.dm.policy`):

    - `pairing` (기본)
    - `allowlist`
    - `open` (`channels.discord.allowFrom`이 `"*"`를 포함해야 함; 레거시: `channels.discord.dm.allowFrom`)
    - `disabled`

    다이렉트 메시지 정책이 개방되지 않은 경우, 알 수 없는 사용자는 차단됩니다 (또는 `pairing` 모드에서는 페어링이 요청됩니다).

    다이렉트 메시지 대상 형식은 다음과 같습니다:

    - `user:<id>`
    - `<@id>` 멘션

    명시적 사용자/채널 대상 유형이 제공되지 않으면 단순 숫자 ID는 모호하며 거부됩니다.

  </Tab>

  <Tab title="Guild policy">
    길드 처리는 `channels.discord.groupPolicy`로 제어됩니다:

    - `open`
    - `allowlist`
    - `disabled`

    `channels.discord`가 존재할 때 보안 기준선은 `allowlist`입니다.

    `allowlist` 동작:

    - 길드는 `channels.discord.guilds`와 일치해야 합니다 (`id` 권장, 슬러그 허용)
    - 선택적 발신자 허용 목록: `users` (ID 또는 이름) 및 `roles` (역할 ID만); 둘 중 하나가 구성된 경우, 발신자는 `users` 또는 `roles`와 일치할 때 허용됩니다.
    - `users`에는 이름/태그가 지원되지만 ID가 더 안전합니다; `openclaw security audit`는 이름/태그 항목이 사용될 때 경고합니다
    - 길드에 `channels`가 구성된 경우, 나열되지 않은 채널은 거부됩니다.
    - 길드에 `channels` 블록이 없는 경우, 허용 목록에 있는 길드의 모든 채널이 허용됩니다.

    예시:

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    `DISCORD_BOT_TOKEN`만 설정하고 `channels.discord` 블록을 생성하지 않으면, 런타임 대체는 `groupPolicy="open"`입니다 (로그에 경고와 함께).

  </Tab>

  <Tab title="Mentions and group DMs">
    길드 메시지는 기본적으로 멘션 게이트되어 있습니다.

    멘션 감지는 다음을 포함합니다:

    - 명시적 봇 멘션
    - 구성된 멘션 패턴 (`agents.list[].groupChat.mentionPatterns`, 초깃값 `messages.groupChat.mentionPatterns`)
    - 지원되는 경우에 봇에 대한 암시적 답장 행동

    `requireMention`은 길드/채널별로 구성되어 있습니다 (`channels.discord.guilds...`).

    그룹 다이렉트 메시지:

    - 기본: 무시됨 (`dm.groupEnabled=false`)
    - 선택적 허용 목록 `dm.groupChannels`를 통해 (채널 ID 또는 슬러그)

  </Tab>
</Tabs>

### Role-based agent routing

Discord 길드 멤버를 역할 ID에 따라 다른 에이전트로 라우팅하기 위해 `bindings[].match.roles`를 사용하세요. 역할 기반 바인딩은 역할 ID만 허용하며 피어 또는 부모 피어 바인딩 후, 길드 전용 바인딩 전 평가됩니다. 바인딩이 다른 매치 필드도 설정하는 경우 (예: `peer` + `guildId` + `roles`), 모든 구성 필드가 일치해야 합니다.

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## Developer Portal setup

<AccordionGroup>
  <Accordion title="Create app and bot">

    1. Discord 개발자 포털 -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. 봇 토큰 복사

  </Accordion>

  <Accordion title="Privileged intents">
    **Bot -> Privileged Gateway Intents**에서 활성화:

    - Message Content Intent
    - Server Members Intent (권장)

    Presence intent는 선택적이며 상태 업데이트를 받고 싶을 경우에만 필요합니다. 봇 상태 설정 (`setPresence`)은 멤버 상태 업데이트를 활성화하지 않고도 가능합니다.

  </Accordion>

  <Accordion title="OAuth scopes and baseline permissions">
    OAuth URL 생성기:

    - 범위: `bot`, `applications.commands`

    일반적인 기본 권한:

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions (선택적)

    `Administrator`를 명시적으로 필요로 하지 않는 한 피하세요.

  </Accordion>

  <Accordion title="Copy IDs">
    Discord 개발자 모드를 활성화한 다음 복사하세요:

    - 서버 ID
    - 채널 ID
    - 사용자 ID

    신뢰할 수 있는 감사 및 검증을 위해 OpenClaw 설정에서 숫자 ID를 선호합니다.

  </Accordion>
</AccordionGroup>

## Native commands and command auth

- `commands.native`는 기본적으로 `"auto"`이며 Discord에서 활성화됩니다.
- 채널별 오버라이드: `channels.discord.commands.native`.
- `commands.native=false`는 이전에 등록된 Discord 네이티브 명령어를 명시적으로 지웁니다.
- 네이티브 명령어 인증은 일반 메시지 처리와 동일하게 Discord 허용 목록/정책을 사용합니다.
- 명령어는 Discord UI에 명단이 없는 사용자를 위해 표시될 수 있지만, 실행은 여전히 OpenClaw 인증을 강제하고 "승인되지 않았습니다"라는 응답을 반환합니다.

명령어 카탈로그 및 동작을 보려면 [Slash commands](/ko-KR/tools/slash-commands)를 참고하세요.

기본 슬래시 명령어 설정:

- `ephemeral: true`

## Feature details

<AccordionGroup>
  <Accordion title="Reply tags and native replies">
    Discord는 에이전트 출력에 응답 태그를 지원합니다:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    `channels.discord.replyToMode`로 제어됩니다:

    - `off` (기본)
    - `first`
    - `all`

    참고: `off`는 암시적 응답 스레딩을 비활성화합니다. 명시적 `[[reply_to_*]]` 태그는 여전히 존중됩니다.

    메시지 ID는 에이전트가 특정 메시지를 타겟팅할 수 있도록 컨텍스트/히스토리에 표시됩니다.

  </Accordion>

  <Accordion title="Live stream preview">
    OpenClaw는 임시 메시지를 전송하고 텍스트가 도착하면 수정하여 초안 답글을 스트리밍할 수 있습니다.

    - `channels.discord.streaming`은 미리보기 스트리밍을 제어합니다 (`off` | `partial` | `block` | `progress`, 기본값: `off`).
    - `progress`는 교차 채널 일관성을 위해 허용되며 Discord에서 `partial`로 매핑됩니다.
    - `channels.discord.streamMode`는 레거시 별칭이며 자동으로 마이그레이션됩니다.
    - `partial`은 토큰이 도착함에 따라 단일 미리보기 메시지를 편집합니다.
    - `block`은 초안 크기 청크를 내보냅니다 (`draftChunk`로 크기와 구분점 조정).

    예시:

```json5
{
  channels: {
    discord: {
      streaming: "partial",
    },
  },
}
```

    `block` 모드 청킹 기본값 (`channels.discord.textChunkLimit`으로 제한됨):

```json5
{
  channels: {
    discord: {
      streaming: "block",
      draftChunk: {
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph",
      },
    },
  },
}
```

    미리보기 스트리밍은 텍스트 전용입니다; 미디어 답글은 일반 전달로 폴백됩니다.

    참고: 미리보기 스트리밍은 블록 스트리밍과 별도입니다. Discord에 블록 스트리밍이 명시적으로 활성화된 경우, OpenClaw는 이중 스트리밍을 방지하기 위해 미리보기 스트림을 건너뜁니다.

  </Accordion>

  <Accordion title="History, context, and thread behavior">
    길드 히스토리 컨텍스트:

    - `channels.discord.historyLimit` 기본값 `20`
    - 초깃값: `messages.groupChat.historyLimit`
    - `0` 비활성화

    다이렉트 메시지 히스토리 제어:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    스레드 동작:

    - Discord 스레드는 채널 세션으로 라우팅됩니다
    - 부모 스레드 메타데이터를 부모 세션 연결에 사용할 수 있습니다
    - 스레드 설정은 스레드별 항목이 없으면 부모 채널 설정을 상속받습니다

    채널 주제는 **신뢰할 수 없는** 컨텍스트로 주입됩니다 (시스템 프롬프트로 아님).

  </Accordion>

  <Accordion title="Thread-bound sessions for subagents">
    Discord는 스레드를 세션 대상에 바인딩하여 해당 스레드의 후속 메시지가 동일한 세션(서브에이전트 세션 포함)으로 계속 라우팅되도록 할 수 있습니다.

    명령어:

    - `/focus <target>` 현재/새 스레드를 서브에이전트/세션 대상에 바인딩
    - `/unfocus` 현재 스레드 바인딩 제거
    - `/agents` 활성 실행 및 바인딩 상태 표시
    - `/session ttl <duration|off>` 집중 바인딩의 자동 해제 TTL 확인/업데이트

    설정:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      ttlHours: 24,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        ttlHours: 24,
        spawnSubagentSessions: false, // 명시적 활성화 필요
      },
    },
  },
}
```

    참고:

    - `session.threadBindings.*`는 글로벌 기본값을 설정합니다.
    - `channels.discord.threadBindings.*`는 Discord 동작을 오버라이드합니다.
    - `spawnSubagentSessions`는 `sessions_spawn({ thread: true })`로 스레드를 자동 생성/바인딩하려면 true여야 합니다.
    - 계정에 스레드 바인딩이 비활성화된 경우, `/focus` 및 관련 스레드 바인딩 작업을 사용할 수 없습니다.

    [Sub-agents](/ko-KR/tools/subagents) 및 [Configuration Reference](/ko-KR/gateway/configuration-reference)를 참고하세요.

  </Accordion>

  <Accordion title="Reaction notifications">
    길드별 반응 알림 모드:

    - `off`
    - `own` (기본)
    - `all`
    - `allowlist` (`guilds.<id>.users` 참조)

    반응 이벤트는 시스템 이벤트로 변환되어 라우팅된 Discord 세션에 첨부됩니다.

  </Accordion>

  <Accordion title="Ack reactions">
    `ackReaction`은 OpenClaw가 인바운드 메시지를 처리하는 동안 인정을 나타내는 이모지를 보냅니다.

    해상도 순서:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - 에이전트 아이덴티티 이모지 초깃값 (`agents.list[].identity.emoji`, 그렇지 않으면 "👀")

    참고:

    - Discord는 유니코드 이모지 또는 사용자 정의 이모지 이름을 허용합니다.
    - `""`를 사용하여 채널 또는 계정에 대한 반응을 비활성화하세요.

  </Accordion>

  <Accordion title="Config writes">
    채널 시작 설정 쓰기는 기본적으로 활성화되어 있습니다.

    이는 `/config set|unset` 흐름에 영향을 미칩니다 (명령어 기능이 활성화된 경우).

    비활성화:

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Gateway proxy">
    Discord 게이트웨이 웹소켓 트래픽과 시작 REST 조회 (애플리케이션 ID + 허용 목록 해상도)를 HTTP(S) 프록시를 통해 라우팅하세요 `channels.discord.proxy`.

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    계정별 오버라이드:

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="PluralKit support">
    대리 메시지를 시스템 멤버 아이덴티티에 매핑하기 위해 PluralKit 해상도를 활성화하세요:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // 선택적; 비공개 시스템에 필요
      },
    },
  },
}
```

    참고 사항:

    - 허용 목록은 `pk:<memberId>`를 사용할 수 있습니다
    - 멤버 표시 이름은 이름/슬러그로 일치됩니다
    - 조회는 원본 메시지 ID를 사용하며 시간 제약 내에 있습니다
    - 조회 실패 시, 대리 메시지는 봇 메시지로 처리되고 `allowBots=true`가 아닌 이상 삭제됩니다

  </Accordion>

  <Accordion title="Presence configuration">
    상태 또는 활동 필드를 설정했을 때에만 상태 업데이트가 적용됩니다.

    상태만 설정한 예시:

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    활동 예시 (커스텀 상태는 기본 활동 유형입니다):

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    스트리밍 예시:

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    활동 유형 맵:

    - 0: Playing
    - 1: Streaming (`activityUrl` 요구)
    - 2: Listening
    - 3: Watching
    - 4: Custom (활동 텍스트를 상태 상태로 사용; 이모지 선택적)
    - 5: Competing

  </Accordion>

  <Accordion title="Exec approvals in Discord">
    Discord는 다이렉트 메시지에서 버튼 기반 실행 승인 및 옵션으로 원래 채널에 승인 프롬프트를 게시할 수 있습니다.

    구성 경로:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, 기본: `dm`)
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    `target`이 `channel` 또는 `both`일 때, 승인 프롬프트는 채널에서 표시됩니다. 구성된 승인자만 버튼을 사용할 수 있으며, 다른 사용자는 에페멀로 거부를 받습니다. 승인 프롬프트는 명령어 텍스트를 포함하므로 신뢰할 수 있는 채널에만 채널 전달을 활성화하세요. 채널 ID가 세션 키에서 파생될 수 없는 경우, OpenClaw는 다이렉트 메시지 전달로 대체합니다.

    승인 실패 시 알 수 없는 승인 ID로 오류가 발생하면, 승인자 목록 및 기능 활성화를 확인하세요.

    관련 문서: [Exec approvals](/ko-KR/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## Tools and action gates

Discord 메시지 작업에는 메시징, 채널 관리자, 모더레이션, 존재, 및 메타데이터 작업이 포함됩니다.

핵심 예:

- 메시징: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- 반응: `react`, `reactions`, `emojiList`
- 모더레이션: `timeout`, `kick`, `ban`
- 존재: `setPresence`

액션 게이트는 `channels.discord.actions.*.` 아래에 존재합니다.

기본 게이트 동작:

| Action group                                                                                                                                   | Default  |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 반응, 메시지, 스레드, 핀, 설문조사, 검색, 멤버 정보, 역할 정보, 채널 정보, 채널, 음성 상태, 이벤트, 스티커, 이모지 업로드, 스티커 업로드, 권한 | enabled  |
| 역할                                                                                                                                           | disabled |
| 모더레이션                                                                                                                                     | disabled |
| 존재                                                                                                                                           | disabled |

## Components v2 UI

OpenClaw는 승인 및 교차 컨텍스트 마커를 위한 Discord components v2를 사용합니다. Discord 메시지 작업도 `components`를 사용자 정의 UI로 허용할 수 있습니다 (고급; Carbon 컴포넌트 인스턴스 필요), 반면에 레거시 `embeds`는 여전히 사용 가능하나 권장되지 않습니다.

- `channels.discord.ui.components.accentColor`는 Discord 컴포넌트 컨테이너에 사용되는 강조 색깔을 설정합니다 (16진수).
- 계정별로 `channels.discord.accounts.<id>.ui.components.accentColor`에 설정합니다.
- `embeds`는 components v2가 있는 경우 무시됩니다.

예시:

```json5
{
  channels: {
    discord: {
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
    },
  },
}
```

## 음성 채널

OpenClaw는 실시간 연속 대화를 위해 Discord 음성 채널에 참여할 수 있습니다. 이는 음성 메시지 첨부 파일과 별개입니다.

요구 사항:

- 네이티브 명령어 활성화 (`commands.native` 또는 `channels.discord.commands.native`).
- `channels.discord.voice` 설정.
- 봇은 대상 음성 채널에서 연결 + 발언 권한이 필요합니다.

Discord 전용 네이티브 명령어 `/vc join|leave|status`를 사용하여 세션을 제어하세요. 명령어는 계정 기본 에이전트를 사용하며 다른 Discord 명령어와 동일한 허용 목록 및 그룹 정책 규칙을 따릅니다.

자동 참여 예시:

```json5
{
  channels: {
    discord: {
      voice: {
        enabled: true,
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
          },
        ],
        tts: {
          provider: "openai",
          openai: { voice: "alloy" },
        },
      },
    },
  },
}
```

참고:

- `voice.tts`는 음성 재생에만 `messages.tts`를 오버라이드합니다.
- 음성은 기본적으로 활성화됩니다; `channels.discord.voice.enabled=false`로 비활성화하세요.

## Voice messages

Discord 음성 메시지는 파형 미리 보기를 표시하고 OGG/Opus 형식의 오디오와 메타데이터가 필요합니다. OpenClaw는 파형을 자동으로 생성하지만, 오디오 파일을 검사하고 변환하려면 `ffmpeg` 및 `ffprobe`가 게이트웨이 호스트에 필요합니다.

요구 사항과 제약 조건:

- **로컬 파일 경로**를 제공해야 합니다 (URL은 거부됨).
- 텍스트 콘텐츠를 생략하세요 (Discord는 동일한 페이로드에서 텍스트 + 음성 메시지를 허용하지 않습니다).
- 모든 오디오 형식이 허용됩니다; 요구 사항에 맞춰 OpenClaw가 OGG/Opus로 변환합니다.

예시:

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="Used disallowed intents or bot sees no guild messages">

    - Message Content Intent를 활성화합니다
    - 사용자/멤버 해상도에 의존할 때 Server Members Intent를 활성화합니다
    - 인텐트를 변경한 후 게이트웨이를 재시작합니다

  </Accordion>

  <Accordion title="Guild messages blocked unexpectedly">

    - `groupPolicy`를 점검합니다
    - `channels.discord.guilds` 아래 길드 허용 목록을 점검합니다
    - 길드 `channels` 맵이 존재하는 경우, 나열된 채널만 허용됩니다
    - `requireMention` 동작 및 멘션 패턴을 점검합니다

    유용한 점검:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Require mention false but still blocked">
    일반적인 원인:

    - `groupPolicy="allowlist"`가 일치하는 길드/채널 허용 목록 없이 설정됨
    - 잘못된 위치에 `requireMention`이 구성됨 (`channels.discord.guilds` 또는 채널 항목 아래에 있어야 함)
    - 길드/채널 `users` 허용 목록에 의해 발신자가 차단됨

  </Accordion>

  <Accordion title="Permissions audit mismatches">
    `channels status --probe` 권한 점검은 숫자 채널 ID에 대해서만 작동합니다.

    슬러그 키를 사용하는 경우, 런타임 매칭은 여전히 작동할 수 있지만 점검은 권한을 완전히 확인할 수 없습니다.

  </Accordion>

  <Accordion title="DM and pairing issues">

    - DM 비활성화: `channels.discord.dm.enabled=false`
    - DM 정책 비활성화: `channels.discord.dmPolicy="disabled"` (레거시: `channels.discord.dm.policy`)
    - `pairing` 모드에서 페어링 승인 대기 중

  </Accordion>

  <Accordion title="Bot to bot loops">
    기본적으로 봇이 작성한 메시지는 무시됩니다.

    `channels.discord.allowBots=true`를 설정하는 경우, 반복 행동을 피하기 위해 엄격한 멘션 및 허용 목록 규칙을 사용하세요.

  </Accordion>
</AccordionGroup>

## Configuration reference pointers

Primary reference:

- [Configuration reference - Discord](/ko-KR/gateway/configuration-reference#discord)

High-signal Discord fields:

- startup/auth: `enabled`, `token`, `accounts.*`, `allowBots`
- policy: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- command: `commands.native`, `commands.useAccessGroups`, `configWrites`, `slashCommand.*`
- reply/history: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- streaming: `streaming` (레거시 별칭: `streamMode`), `draftChunk`, `blockStreaming`, `blockStreamingCoalesce`
- media/retry: `mediaMaxMb`, `retry`
- actions: `actions.*`
- presence: `activity`, `status`, `activityType`, `activityUrl`
- UI: `ui.components.accentColor`
- features: `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## Safety and operations

- 봇 토큰을 비밀로 취급하세요 (`DISCORD_BOT_TOKEN`을 감시되는 환경에서 선호).
- 최소 권한의 Discord 권한을 부여하세요.
- 명령어 배포/상이 정체되면 게이트웨이를 재시작하고 `openclaw channels status --probe`로 다시 점검하세요.

## Related

- [Pairing](/ko-KR/channels/pairing)
- [Channel routing](/ko-KR/channels/channel-routing)
- [Multi-agent routing](/ko-KR/concepts/multi-agent)
- [Troubleshooting](/ko-KR/channels/troubleshooting)
- [Slash commands](/ko-KR/tools/slash-commands)
