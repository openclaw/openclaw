---
summary: "Discord 봇 지원 상태, 기능, 그리고 설정"
read_when:
  - Discord 채널 기능 작업 중
title: "Discord"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/channels/discord.md"
  workflow: 15
---

# Discord (Bot API)

상태: Discord 게이트웨이를 통한 DM 및 길드 채널 지원 준비 완료.

<CardGroup cols={3}>
  <Card title="페어링" icon="link" href="/channels/pairing">
    Discord DM은 기본적으로 페어링 모드입니다.
  </Card>
  <Card title="슬래시 명령어" icon="terminal" href="/tools/slash-commands">
    기본 명령어 동작 및 명령어 카탈로그.
  </Card>
  <Card title="채널 문제 해결" icon="wrench" href="/channels/troubleshooting">
    채널 간 진단 및 복구 흐름.
  </Card>
</CardGroup>

## 빠른 설정

새 애플리케이션을 만들고 봇을 추가한 후 OpenClaw에 페어링해야 합니다. 자신의 비공개 서버에 봇을 추가하는 것을 권장합니다. 아직 없다면 [먼저 만드세요](https://support.discord.com/hc/en-us/articles/204849977-How-do-I-create-a-server) (**내가 직접 만들기 > 나와 친구들을 위해**).

<Steps>
  <Step title="Discord 애플리케이션 및 봇 만들기">
    [Discord Developer Portal](https://discord.com/developers/applications)로 이동하여 **새 애플리케이션**을 클릭합니다. "OpenClaw"와 같이 이름을 지정합니다.

    사이드바에서 **봇**을 클릭합니다. **사용자 이름**을 OpenClaw 에이전트에 대해 원하는 이름으로 설정합니다.

  </Step>

  <Step title="특권 인텐트 활성화">
    여전히 **봇** 페이지에서 아래로 스크롤하여 **특권 게이트웨이 인텐트**를 찾고 다음을 활성화합니다:

    - **메시지 콘텐츠 인텐트** (필수)
    - **서버 멤버 인텐트** (권장; 역할 허용 목록 및 이름-ID 매칭에 필수)
    - **프레젌스 인텐트** (선택사항; 프레젌스 업데이트에만 필요)

  </Step>

  <Step title="봇 토큰 복사">
    **봇** 페이지에서 다시 위로 스크롤하여 **토큰 재설정**을 클릭합니다.

    <Note>
    이름과 달리 이는 첫 번째 토큰을 생성합니다 — "재설정"되는 것은 없습니다.
    </Note>

    토큰을 복사하여 어딘가에 저장합니다. 이것이 **봇 토큰**이며 곧 필요합니다.

  </Step>

  <Step title="초대 URL 생성 및 봇을 서버에 추가">
    사이드바에서 **OAuth2**를 클릭합니다. 서버에 봇을 추가할 올바른 권한으로 초대 URL을 생성합니다.

    아래로 스크롤하여 **OAuth2 URL 생성기**를 찾고 다음을 활성화합니다:

    - `bot`
    - `applications.commands`

    아래에 **봇 권한** 섹션이 나타납니다. 다음을 활성화합니다:

    - 채널 보기
    - 메시지 전송
    - 메시지 이력 읽기
    - 링크 포함
    - 파일 첨부
    - 반응 추가 (선택사항)

    아래에 생성된 URL을 복사하여 브라우저에 붙여넣고, 서버를 선택하고 **계속**을 클릭합니다. 이제 Discord 서버에서 봇을 볼 수 있습니다.

  </Step>

  <Step title="개발자 모드 활성화 및 ID 수집">
    Discord 앱에서 내부 ID를 복사할 수 있도록 개발자 모드를 활성화해야 합니다.

    1. **사용자 설정** (아바타 옆의 톱니바퀴 아이콘) → **고급** → **개발자 모드** 토글 켜기
    2. 사이드바에서 **서버 아이콘**을 마우스 오른쪽 클릭 → **서버 ID 복사**
    3. **자신의 아바타**를 마우스 오른쪽 클릭 → **사용자 ID 복사**

    **서버 ID**와 **사용자 ID**를 봇 토큰과 함께 저장합니다 — 다음 단계에서 모두 OpenClaw에 전송합니다.

  </Step>

  <Step title="서버 멤버의 DM 허용">
    페어링이 작동하려면 Discord에서 봇이 DM을 보낼 수 있도록 허용해야 합니다. **서버 아이콘**을 마우스 오른쪽 클릭 → **개인정보 설정** → **직접 메시지** 토글 켜기.

    이것은 서버 멤버 (봇 포함)가 DM을 보낼 수 있게 합니다. OpenClaw와 Discord DM을 사용하려면 이를 활성화 상태로 유지합니다. 길드 채널만 사용할 계획이라면 페어링 후 DM을 비활성화할 수 있습니다.

  </Step>

  <Step title="단계 0: 봇 토큰을 안전하게 설정 (채팅에 보내지 마세요)">
    Discord 봇 토큰은 비밀입니다 (암호처럼). OpenClaw를 실행 중인 머신에서 에이전트에 메시지를 보내기 전에 설정합니다.

```bash
openclaw config set channels.discord.token '"YOUR_BOT_TOKEN"' --json
openclaw config set channels.discord.enabled true --json
openclaw gateway
```

    OpenClaw이 이미 백그라운드 서비스로 실행 중이면 `openclaw gateway restart`를 대신 사용합니다.

  </Step>

  <Step title="OpenClaw 설정 및 페어링">

    <Tabs>
      <Tab title="에이전트에 요청">
        기존 채널 (예: Telegram)에서 OpenClaw 에이전트와 대화하고 알려줍니다. Discord가 첫 번째 채널인 경우 대신 CLI / 설정 탭을 사용합니다.

        > "Discord 봇 토큰을 이미 설정했습니다. 사용자 ID `<user_id>`와 서버 ID `<server_id>`로 Discord 설정을 완료해 주세요."
      </Tab>
      <Tab title="CLI / 설정">
        파일 기반 설정을 선호하면 다음을 설정합니다:

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

        기본 계정의 환경 변수 폴백:

```bash
DISCORD_BOT_TOKEN=...
```

      </Tab>
    </Tabs>

  </Step>

  <Step title="첫 번째 DM 페어링 승인">
    게이트웨이가 실행 중일 때까지 기다린 후, Discord에서 봇에 DM을 보냅니다. 페어링 코드로 응답합니다.

    <Tabs>
      <Tab title="에이전트에 요청">
        페어링 코드를 기존 채널의 에이전트에 보냅니다:

        > "이 Discord 페어링 코드 승인: `<CODE>`"
      </Tab>
      <Tab title="CLI">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

      </Tab>
    </Tabs>

    페어링 코드는 1시간 후 만료됩니다.

    이제 Discord의 DM을 통해 에이전트와 대화할 수 있습니다.

  </Step>
</Steps>

<Note>
토큰 해결은 계정 인식입니다. 설정 토큰 값이 환경 변수 폴백보다 우선합니다. `DISCORD_BOT_TOKEN`은 기본 계정에만 사용됩니다.
</Note>

## 권장됨: 길드 작업 공간 설정

DM이 작동하면 각 채널이 고유한 컨텍스트로 자신의 에이전트 세션을 갖는 전체 작업 공간으로 Discord 서버를 설정할 수 있습니다. 자신과 봇만 있는 비공개 서버의 경우 권장됩니다.

<Steps>
  <Step title="서버를 길드 허용 목록에 추가">
    이것은 에이전트가 DM뿐만 아니라 서버의 모든 채널에 응답할 수 있게 합니다.

    <Tabs>
      <Tab title="에이전트에 요청">
        > "Discord 서버 ID `<server_id>`를 길드 허용 목록에 추가해주세요"
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

  <Step title="@언급 없이 응답 허용">
    기본적으로 에이전트는 길드 채널에서 @언급될 때만 응답합니다. 비공개 서버의 경우 모든 메시지에 응답하고 싶을 것입니다.

    <Tabs>
      <Tab title="에이전트에 요청">
        > "에이전트가 @언급되지 않아도 이 서버에서 응답할 수 있도록 허용해주세요"
      </Tab>
      <Tab title="설정">
        길드 설정에서 `requireMention: false`를 설정합니다:

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

  <Step title="길드 채널에서 메모리 계획">
    기본적으로 장기 메모리 (MEMORY.md)는 DM 세션에만 로드됩니다. 길드 채널은 자동으로 MEMORY.md를 로드하지 않습니다.

    <Tabs>
      <Tab title="에이전트에 요청">
        > "Discord 채널에서 질문할 때, MEMORY.md에서 장기 컨텍스트가 필요하면 memory_search 또는 memory_get을 사용합니다."
      </Tab>
      <Tab title="수동">
        모든 채널에서 공유 컨텍스트가 필요하면 안정적인 지침을 `AGENTS.md` 또는 `USER.md`에 넣으세요 (모든 세션에 주입됩니다). 장기 메모 작업용으로 `MEMORY.md`에 저장하고 메모리 도구로 필요할 때 액세스합니다.
      </Tab>
    </Tabs>

  </Step>
</Steps>

이제 Discord 서버에서 채널을 만들고 대화를 시작합니다. 에이전트가 채널 이름을 볼 수 있으며, 각 채널은 자체 격리된 세션을 가집니다 — `#coding`, `#home`, `#research` 등 워크플로우에 맞는 것을 설정할 수 있습니다.

## 런타임 모델

- 게이트웨이가 Discord 연결을 소유합니다.
- 응답 라우팅은 결정적입니다: Discord 인바운드는 Discord로 다시 회신합니다.
- 기본적으로 (`session.dmScope=main`), 직접 채팅은 에이전트 메인 세션을 공유합니다 (`agent:main:main`).
- 길드 채널은 격리된 세션 키입니다 (`agent:<agentId>:discord:channel:<channelId>`).
- 그룹 DM은 기본적으로 무시됩니다 (`channels.discord.dm.groupEnabled=false`).
- 네이티브 슬래시 명령어는 격리된 명령어 세션에서 실행되지만 (`agent:<agentId>:discord:slash:<userId>`), 라우팅된 대화 세션으로 `CommandTargetSessionKey`를 전달합니다.

## 포럼 채널

Discord 포럼 및 미디어 채널은 스레드 게시물만 허용합니다. OpenClaw는 두 가지 방식으로 생성을 지원합니다:

- 포럼 부모에 메시지를 보냅니다 (`channel:<forumId>`) 스레드를 자동 생성합니다. 스레드 제목은 메시지의 첫 번째 비어있지 않은 줄을 사용합니다.
- `openclaw message thread create`를 사용하여 스레드를 직접 생성합니다. 포럼 채널의 경우 `--message-id`를 전달하지 마세요.

예: 포럼 부모에 보내 스레드 생성

```bash
openclaw message send --channel discord --target channel:<forumId> \
  --message "주제 제목\n게시물 본문"
```

예: 포럼 스레드 명시적으로 생성

```bash
openclaw message thread create --channel discord --target channel:<forumId> \
  --thread-name "주제 제목" --message "게시물 본문"
```

포럼 부모는 Discord 컴포넌트를 허용하지 않습니다. 컴포넌트가 필요하면 스레드 자체에 보냅니다 (`channel:<threadId>`).

## 대화형 컴포넌트

OpenClaw는 에이전트 메시지에 대해 Discord 컴포넌트 v2 컨테이너를 지원합니다. `components` 페이로드가 있는 메시지 도구를 사용합니다. 상호작용 결과는 일반 인바운드 메시지로 에이전트로 라우팅되고 기존 Discord `replyToMode` 설정을 따릅니다.

지원되는 블록:

- `text`, `section`, `separator`, `actions`, `media-gallery`, `file`
- 액션 행은 최대 5개의 버튼 또는 단일 선택 메뉴를 허용합니다
- 선택 유형: `string`, `user`, `role`, `mentionable`, `channel`

기본적으로 컴포넌트는 한 번만 사용 가능합니다. `components.reusable=true`로 설정하여 만료될 때까지 여러 번 사용할 버튼, 선택 및 양식을 허용합니다.

버튼을 클릭할 수 있는 사람을 제한하려면 해당 버튼에서 `allowedUsers`를 설정합니다 (Discord 사용자 ID, 태그 또는 `*`). 구성될 때 일치하지 않는 사용자는 임시 거부를 받습니다.

`/model` 및 `/models` 슬래시 명령어는 제공자 및 모델 드롭다운과 제출 단계가 있는 대화형 모델 선택기를 엽니다. 선택기 응답은 임시이며 호출 사용자만 사용할 수 있습니다.

파일 첨부:

- `file` 블록은 첨부 참조를 가리켜야 합니다 (`attachment://<filename>`)
- `media`/`path`/`filePath`를 통해 첨부를 제공합니다 (단일 파일); 여러 파일의 경우 `media-gallery` 사용
- 첨부 참조와 일치해야 할 때 업로드 이름을 재정의하려면 `filename`을 사용합니다

모달 양식:

- 최대 5개 필드를 포함하는 `components.modal` 추가
- 필드 유형: `text`, `checkbox`, `radio`, `select`, `role-select`, `user-select`
- OpenClaw는 자동으로 트리거 버튼을 추가합니다

예:

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "선택적 폴백 텍스트",
  components: {
    reusable: true,
    text: "경로를 선택합니다",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "승인",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "거절", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "옵션 선택",
          options: [
            { label: "옵션 A", value: "a" },
            { label: "옵션 B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "세부 정보",
      triggerLabel: "양식 열기",
      fields: [
        { type: "text", label: "요청자" },
        {
          type: "select",
          label: "우선순위",
          options: [
            { label: "낮음", value: "low" },
            { label: "높음", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## 접근 제어 및 라우팅

<Tabs>
  <Tab title="DM 정책">
    `channels.discord.dmPolicy`는 DM 접근을 제어합니다 (레거시: `channels.discord.dm.policy`):

    - `pairing` (기본값)
    - `allowlist`
    - `open` (requires `channels.discord.allowFrom` to include `"*"`; legacy: `channels.discord.dm.allowFrom`)
    - `disabled`

    DM 정책이 열려 있지 않으면 알 수 없는 사용자가 차단됩니다 (또는 `pairing` 모드에서 페어링 요청).

    다중 계정 우선순위:

    - `channels.discord.accounts.default.allowFrom`은 `default` 계정에만 적용됩니다.
    - 명명된 계정은 자신의 `allowFrom`이 설정되지 않을 때 `channels.discord.allowFrom`을 상속합니다.
    - 명명된 계정은 `channels.discord.accounts.default.allowFrom`을 상속하지 않습니다.

    배송용 DM 대상 형식:

    - `user:<id>`
    - `<@id>` 멘션

    베어 숫자 ID는 모호하며 명시적 사용자/채널 대상 종류가 제공되지 않으면 거절됩니다.

  </Tab>

  <Tab title="길드 정책">
    길드 처리는 `channels.discord.groupPolicy`로 제어됩니다:

    - `open`
    - `allowlist`
    - `disabled`

    `channels.discord`가 존재할 때의 보안 기준은 `allowlist`입니다.

    `allowlist` 동작:

    - 길드는 `channels.discord.guilds` (`id` 선호, slug 허용)와 일치해야 합니다
    - 선택적 발신자 허용 목록: `users` (안정적 ID 권장) 및 `roles` (역할 ID만); 하나라도 구성되면 발신자가 `users` 또는 `roles`과 일치할 때 허용됩니다
    - 직접 이름/태그 매칭은 기본적으로 비활성화됨; `channels.discord.dangerouslyAllowNameMatching: true`로만 활성화 (하위 호환성 모드)
    - 이름/태그는 `users`에서 지원되지만 ID가 더 안전합니다; `openclaw security audit`은 이름/태그 항목 사용 시 경고합니다
    - 길드에 `channels` 구성이 있으면 나열되지 않은 채널이 거부됩니다
    - 길드에 `channels` 블록이 없으면 해당 허용 목록에 있는 길드의 모든 채널이 허용됩니다

    예:

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

    `DISCORD_BOT_TOKEN`만 설정하고 `channels.discord` 블록을 만들지 않으면 런타임 폴백은 `groupPolicy="allowlist"` (로그의 경고와 함께)이며, `channels.defaults.groupPolicy`가 `open`이라도 마찬가지입니다.

  </Tab>

  <Tab title="멘션 및 그룹 DM">
    길드 메시지는 기본적으로 멘션 게이트됩니다.

    멘션 감지 포함:

    - 명시적 봇 멘션
    - 설정된 멘션 패턴 (`agents.list[].groupChat.mentionPatterns`, 폴백 `messages.groupChat.mentionPatterns`)
    - 암시적 봇에 대한 회신 동작 (지원되는 경우)

    `requireMention`은 길드/채널당 구성됩니다 (`channels.discord.guilds...`).

    그룹 DM:

    - 기본값: 무시 (`dm.groupEnabled=false`)
    - 선택적 허용 목록 via `dm.groupChannels` (채널 ID 또는 슬러그)

  </Tab>
</Tabs>

### 역할 기반 에이전트 라우팅

`bindings[].match.roles`를 사용하여 Discord 길드 멤버를 역할 ID로 다양한 에이전트로 라우팅합니다. 역할 기반 바인딩은 역할 ID만 허용하며 피어 또는 부모-피어 바인딩 후, 길드 전용 바인딩 전에 평가됩니다. 바인딩이 다른 일치 필드도 설정하면 (예: `peer` + `guildId` + `roles`), 모든 구성된 필드가 일치해야 합니다.

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

## Developer Portal 설정

<AccordionGroup>
  <Accordion title="앱 및 봇 만들기">

    1. Discord Developer Portal -> **애플리케이션** -> **새 애플리케이션**
    2. **봇** -> **봇 추가**
    3. 봇 토큰 복사

  </Accordion>

  <Accordion title="특권 인텐트">
    **봇 -> 특권 게이트웨이 인텐트**에서 다음을 활성화합니다:

    - Message Content Intent
    - Server Members Intent (권장)

    Presence 인텐트는 선택사항이며 멤버 프레젠스 업데이트를 받으려면 필요합니다. 봇 프레젠스 설정 (`setPresence`)은 멤버에 대한 프레젠스 업데이트 활성화를 필요로 하지 않습니다.

  </Accordion>

  <Accordion title="OAuth 범위 및 기준 권한">
    OAuth URL 생성기:

    - 범위: `bot`, `applications.commands`

    일반적인 기준 권한:

    - 채널 보기
    - 메시지 전송
    - 메시지 이력 읽기
    - 링크 포함
    - 파일 첨부
    - 반응 추가 (선택사항)

    명시적으로 필요하지 않으면 `관리자`를 피합니다.

  </Accordion>

  <Accordion title="ID 복사">
    Discord 개발자 모드를 활성화한 후 다음을 복사합니다:

    - 서버 ID
    - 채널 ID
    - 사용자 ID

    신뢰할 수 있는 감사 및 프로브를 위해 OpenClaw 설정에서 숫자 ID를 선호합니다.

  </Accordion>
</AccordionGroup>

## 네이티브 명령어 및 명령어 인증

- `commands.native`는 기본값이 `"auto"`이며 Discord에 대해 활성화됩니다.
- 채널별 재정의: `channels.discord.commands.native`.
- `commands.native=false`는 명시적으로 이전에 등록된 Discord 네이티브 명령어를 지웁니다.
- 네이티브 명령어 인증은 일반 메시지 처리와 동일한 Discord 허용 목록/정책을 사용합니다.
- 명령어는 권한이 없는 사용자의 Discord UI에서 여전히 볼 수 있습니다; 실행은 여전히 OpenClaw 인증을 강제하고 "권한 없음"을 반환합니다.

[슬래시 명령어](/tools/slash-commands)에서 명령어 카탈로그 및 동작을 참조하세요.

기본 슬래시 명령어 설정:

- `ephemeral: true`

## 기능 세부 사항

<AccordionGroup>
  <Accordion title="회신 태그 및 네이티브 회신">
    Discord는 에이전트 출력에서 회신 태그를 지원합니다:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    `channels.discord.replyToMode`로 제어됩니다:

    - `off` (기본값)
    - `first`
    - `all`

    참고: `off`는 암시적 회신 스레딩을 비활성화합니다. 명시적 `[[reply_to_*]]` 태그는 여전히 존중됩니다.

    메시지 ID는 컨텍스트/이력에 표시되므로 에이전트가 특정 메시지를 대상으로 할 수 있습니다.

  </Accordion>

  <Accordion title="라이브 스트림 미리보기">
    OpenClaw는 임시 메시지를 보내고 텍스트가 도착할 때 편집하여 초안 회신을 스트리밍할 수 있습니다.

    - `channels.discord.streaming`은 미리보기 스트리밍을 제어합니다 (`off` | `partial` | `block` | `progress`, 기본값: `off`).
    - 채널 간 일관성을 위해 `progress`가 허용되며 Discord에서 `partial`로 매핑됩니다.
    - `channels.discord.streamMode`는 레거시 별칭이며 자동 마이그레이션됩니다.
    - `partial`은 토큰이 도착할 때 단일 미리보기 메시지를 편집합니다.
    - `block`은 초안 크기 청크를 내보냅니다 (`draftChunk`로 크기 및 분해점 조정).

    예:

```json5
{
  channels: {
    discord: {
      streaming: "partial",
    },
  },
}
```

    `block` 모드 청킹 기본값 (`channels.discord.textChunkLimit`으로 고정):

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

    미리보기 스트리밍은 텍스트 전용입니다; 미디어 회신은 정상 배송으로 폴백합니다.

    참고: 미리보기 스트리밍은 블록 스트리밍과 별개입니다. Discord에 대해 블록 스트리밍이 명시적으로 활성화되면 OpenClaw는 이중 스트리밍을 피하기 위해 미리보기 스트림을 건너뜁니다.

  </Accordion>

  <Accordion title="이력, 컨텍스트, 및 스레드 동작">
    길드 이력 컨텍스트:

    - `channels.discord.historyLimit` 기본값 `20`
    - 폴백: `messages.groupChat.historyLimit`
    - `0`은 비활성화합니다

    DM 이력 컨트롤:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    스레드 동작:

    - Discord 스레드는 채널 세션으로 라우팅됩니다
    - 부모 스레드 메타데이터는 부모-세션 연결에 사용될 수 있습니다
    - 스레드 설정은 특정 스레드 항목이 존재하지 않으면 부모 채널 설정을 상속합니다

    채널 주제는 **신뢰할 수 없는** 컨텍스트로 주입됩니다 (시스템 프롬프트가 아님).

  </Accordion>

  <Accordion title="부분 에이전트에 대한 스레드 바운드 세션">
    Discord는 스레드를 세션 대상에 바인딩하여 해당 스레드의 후속 메시지가 동일 세션 (부분 에이전트 세션 포함)으로 계속 라우팅되도록 할 수 있습니다.

    명령어:

    - `/focus <target>` 현재/새 스레드를 부분 에이전트/세션 대상에 바인딩
    - `/unfocus` 현재 스레드 바인딩 제거
    - `/agents` 활성 실행 및 바인딩 상태 표시
    - `/session idle <duration|off>` 포커스된 바인딩에 대한 비활성 자동 포커스 해제 검사/업데이트
    - `/session max-age <duration|off>` 포커스된 바인딩에 대한 하드 최대 나이 검사/업데이트

    설정:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSubagentSessions: false, // 옵트인
      },
    },
  },
}
```

    참고:

    - `session.threadBindings.*`는 글로벌 기본값을 설정합니다.
    - `channels.discord.threadBindings.*`는 Discord 동작을 재정의합니다.
    - `spawnSubagentSessions`는 `sessions_spawn({ thread: true })`에 대해 자동 생성/바인드 스레드가 true여야 합니다.
    - `spawnAcpSessions`는 ACP (`/acp spawn ... --thread ...` 또는 `sessions_spawn({ runtime: "acp", thread: true })`)에 대해 true여야 합니다.
    - 계정에 대해 스레드 바인딩이 비활성화되면 `/focus` 및 관련 스레드 바인딩 작업을 사용할 수 없습니다.

    [부분 에이전트](/tools/subagents), [ACP 에이전트](/tools/acp-agents), 및 [설정 참조](/gateway/configuration-reference)를 참조하세요.

  </Accordion>

  <Accordion title="반응 알림">
    길드별 반응 알림 모드:

    - `off`
    - `own` (기본값)
    - `all`
    - `allowlist` (uses `guilds.<id>.users`)

    반응 이벤트는 시스템 이벤트로 변환되어 라우팅된 Discord 세션에 첨부됩니다.

  </Accordion>

  <Accordion title="응답 반응">
    `ackReaction`은 OpenClaw이 인바운드 메시지를 처리하는 동안 승인 이모지를 보냅니다.

    해결 순서:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - 에이전트 identity 이모지 폴백 (`agents.list[].identity.emoji`, 아니면 "👀")

    참고:

    - Discord는 유니코드 이모지 또는 커스텀 이모지 이름을 허용합니다.
    - 채널 또는 계정에 대한 반응을 비활성화하려면 `""`를 사용합니다.

  </Accordion>

  <Accordion title="설정 쓰기">
    채널 시작 설정 쓰기는 기본적으로 활성화됩니다.

    이것은 `/config set|unset` 흐름 (명령어 기능이 활성화되었을 때)에 영향을 줍니다.

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

  <Accordion title="게이트웨이 프록시">
    Discord 게이트웨이 WebSocket 트래픽 및 시작 REST 조회 (애플리케이션 ID + 허용 목록 해결)를 HTTP(S) 프록시를 통해 라우팅합니다 (`channels.discord.proxy`).

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    계정별 재정의:

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

  <Accordion title="PluralKit 지원">
    PluralKit 해결을 활성화하여 프록시 메시지를 시스템 멤버 identity에 매핑합니다:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // 선택사항; 비공개 시스템에 필요
      },
    },
  },
}
```

    참고:

    - 허용 목록은 `pk:<memberId>`를 사용할 수 있습니다
    - 멤버 표시 이름은 `channels.discord.dangerouslyAllowNameMatching: true`일 때만 이름/슬러그로 일치합니다
    - 조회는 원본 메시지 ID를 사용하며 시간 창 제약이 있습니다
    - 조회가 실패하면 프록시 메시지는 봇 메시지로 처리되고 `allowBots=true`가 아니면 삭제됩니다

  </Accordion>

  <Accordion title="프레젠스 설정">
    프레젠스 업데이트는 상태 또는 활동 필드를 설정할 때만 적용됩니다.

    상태 전용 예:

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    활동 예 (커스텀 상태는 기본 활동 유형):

```json5
{
  channels: {
    discord: {
      activity: "포커스 시간",
      activityType: 4,
    },
  },
}
```

    스트리밍 예:

```json5
{
  channels: {
    discord: {
      activity: "실시간 코딩",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    활동 유형 맵:

    - 0: Playing
    - 1: Streaming (requires `activityUrl`)
    - 2: Listening
    - 3: Watching
    - 4: Custom (uses the activity text as the status state; emoji is optional)
    - 5: Competing

  </Accordion>

  <Accordion title="Discord에서의 실행 승인">
    Discord는 DM에서 버튼 기반 실행 승인을 지원하며 선택적으로 승인 프롬프트를 원본 채널에 게시할 수 있습니다.

    설정 경로:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, 기본값: `dm`)
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    `target`이 `channel` 또는 `both`일 때, 승인 프롬프트가 채널에서 볼 수 있습니다. 구성된 승인자만 버튼을 사용할 수 있습니다; 다른 사용자는 임시 거부를 받습니다. 승인 프롬프트에는 명령어 텍스트가 포함되므로 신뢰할 수 있는 채널에서만 채널 배송을 활성화합니다. 세션 키에서 채널 ID를 파생할 수 없으면 OpenClaw는 DM 배송으로 폴백합니다.

    승인이 알 수 없는 승인 ID로 실패하면 승인자 목록 및 기능 활성화를 확인합니다.

    관련 문서: [실행 승인](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## 도구 및 액션 게이트

Discord 메시지 액션에는 메시징, 채널 관리, 중재, 프레젠스, 및 메타데이터 액션이 포함됩니다.

핵심 예:

- 메시징: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- 반응: `react`, `reactions`, `emojiList`
- 중재: `timeout`, `kick`, `ban`
- 프레젠스: `setPresence`

액션 게이트는 `channels.discord.actions.*` 아래에 있습니다.

기본 게이트 동작:

| 액션 그룹                                                                                                                                    | 기본값   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 반응, 메시지, 스레드, 핀, 폴, 검색, memberInfo, roleInfo, channelInfo, 채널, voiceStatus, 이벤트, 스티커, emojiUploads, stickerUploads, 권한 | 활성화   |
| 역할                                                                                                                                         | 비활성화 |
| 중재                                                                                                                                         | 비활성화 |
| 프레젠스                                                                                                                                     | 비활성화 |

## 컴포넌트 v2 UI

OpenClaw는 실행 승인 및 교차 컨텍스트 마커에 Discord 컴포넌트 v2를 사용합니다. Discord 메시지 액션은 또한 커스텀 UI에 대해 `components`를 허용할 수 있습니다 (고급; Carbon 컴포넌트 인스턴스 필요), 레거시 `embeds`는 여전히 사용 가능하지만 권장되지 않습니다.

- `channels.discord.ui.components.accentColor`는 Discord 컴포넌트 컨테이너가 사용하는 악센트 색상을 설정합니다 (16진법).
- `channels.discord.accounts.<id>.ui.components.accentColor`로 계정별로 설정합니다.
- 컴포넌트 v2가 있을 때 `embeds`는 무시됩니다.

예:

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

OpenClaw는 실시간 연속 대화를 위해 Discord 음성 채널에 참가할 수 있습니다. 이는 음성 메시지 첨부와 별개입니다.

요구 사항:

- 네이티브 명령어 활성화 (`commands.native` 또는 `channels.discord.commands.native`).
- `channels.discord.voice` 설정.
- 봇은 대상 음성 채널에서 연결 및 말하기 권한이 필요합니다.

Discord 전용 네이티브 명령어 `/vc join|leave|status`를 사용하여 세션을 제어합니다. 명령어는 계정 기본 에이전트를 사용하고 다른 Discord 명령어와 동일한 허용 목록 및 그룹 정책 규칙을 따릅니다.

자동 참가 예:

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
        daveEncryption: true,
        decryptionFailureTolerance: 24,
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

- `voice.tts`는 음성 재생만을 위해 `messages.tts`를 재정의합니다.
- 음성은 기본적으로 활성화되어 있습니다; `channels.discord.voice.enabled=false`로 비활성화합니다.
- `voice.daveEncryption` 및 `voice.decryptionFailureTolerance`는 `@discordjs/voice` 참가 옵션에 전달됩니다.
- `@discordjs/voice` 기본값은 설정되지 않으면 `daveEncryption=true` 및 `decryptionFailureTolerance=24`입니다.
- OpenClaw는 또한 수신 복호화 실패를 감시하고 짧은 창에서 반복된 실패 후 음성 채널을 떠나기/다시 참가하여 자동 복구합니다.
- 수신 로그가 `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`를 반복적으로 표시하면 이는 [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419)에서 추적되는 업스트림 `@discordjs/voice` 수신 버그일 수 있습니다.

## 음성 메시지

Discord 음성 메시지는 파형 미리보기를 표시하고 OGG/Opus 오디오와 메타데이터가 필요합니다. OpenClaw는 파형을 자동으로 생성하지만 게이트웨이 호스트에서 오디오 파일을 검사하고 변환하기 위해 `ffmpeg` 및 `ffprobe`가 필요합니다.

요구 사항 및 제약:

- **로컬 파일 경로** (URL은 거절됩니다)를 제공합니다.
- 텍스트 콘텐츠를 생략합니다 (Discord는 동일 페이로드에서 텍스트 + 음성 메시지를 허용하지 않습니다).
- 모든 오디오 형식이 허용됩니다; OpenClaw는 필요할 때 OGG/Opus로 변환합니다.

예:

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## 문제 해결

<AccordionGroup>
  <Accordion title="허용되지 않은 인텐트 사용 또는 봇이 길드 메시지를 볼 수 없음">

    - Message Content Intent 활성화
    - 사용자/멤버 해결에 의존할 때 Server Members Intent 활성화
    - 인텐트 변경 후 게이트웨이 재시작

  </Accordion>

  <Accordion title="길드 메시지가 예기치 않게 차단됨">

    - `groupPolicy` 확인
    - `channels.discord.guilds` 아래 길드 허용 목록 확인
    - 길드 `channels` 맵이 존재하면 나열된 채널만 허용됩니다
    - `requireMention` 동작 및 멘션 패턴 확인

    유용한 확인:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Require mention false이지만 여전히 차단됨">
    일반적인 원인:

    - 일치하는 길드/채널 허용 목록이 없는 `groupPolicy="allowlist"`
    - `requireMention`이 잘못된 위치에 구성됨 (must be under `channels.discord.guilds` or channel entry)
    - 발신자가 길드/채널 `users` 허용 목록으로 차단됨

  </Accordion>

  <Accordion title="권한 감사 불일치">
    `channels status --probe` 권한 확인은 숫자 채널 ID에만 적용됩니다.

    slug 키를 사용하면 런타임 매칭이 여전히 작동할 수 있지만 프로브는 권한을 완전히 확인할 수 없습니다.

  </Accordion>

  <Accordion title="DM 및 페어링 문제">

    - DM 비활성화: `channels.discord.dm.enabled=false`
    - DM 정책 비활성화: `channels.discord.dmPolicy="disabled"` (레거시: `channels.discord.dm.policy`)
    - `pairing` 모드에서 페어링 승인을 기다리는 중

  </Accordion>

  <Accordion title="봇 대 봇 루프">
    기본적으로 봇 작성 메시지는 무시됩니다.

    `channels.discord.allowBots=true`를 설정하면 루프 동작을 피하기 위해 엄격한 멘션 및 허용 목록 규칙을 사용합니다.

  </Accordion>

  <Accordion title="음성 STT는 DecryptionFailed(...)로 떨어짐">

    - OpenClaw를 현재 상태로 유지합니다 (`openclaw update`) Discord 음성 수신 복구 로직이 있습니다
    - 확인 `channels.discord.voice.daveEncryption=true` (기본값)
    - `channels.discord.voice.decryptionFailureTolerance=24` (업스트림 기본값)에서 시작하고 필요한 경우에만 조정합니다
    - 다음 로그 감시:
      - `discord voice: DAVE decrypt failures detected`
      - `discord voice: repeated decrypt failures; attempting rejoin`
    - 자동 다시 참가 후 실패가 계속되면 로그를 수집하고 [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419)와 비교합니다

  </Accordion>
</AccordionGroup>

## 설정 참조 포인터

기본 참조:

- [설정 참조 - Discord](/gateway/configuration-reference#discord)

높은 신호 Discord 필드:

- 시작/인증: `enabled`, `token`, `accounts.*`, `allowBots`
- 정책: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- 명령어: `commands.native`, `commands.useAccessGroups`, `configWrites`, `slashCommand.*`
- 회신/이력: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 배송: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- 스트리밍: `streaming` (레거시 별칭: `streamMode`), `draftChunk`, `blockStreaming`, `blockStreamingCoalesce`
- 미디어/재시도: `mediaMaxMb`, `retry`
- 액션: `actions.*`
- 프레젠스: `activity`, `status`, `activityType`, `activityUrl`
- UI: `ui.components.accentColor`
- 기능: `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## 안전 및 작업

- 봇 토큰을 비밀로 취급합니다 (`DISCORD_BOT_TOKEN`은 감독된 환경에서 선호).
- Discord 권한을 최소 권한으로 부여합니다.
- 명령어 배포/상태가 오래되었으면 게이트웨이를 재시작하고 `openclaw channels status --probe`로 다시 확인합니다.

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [다중 에이전트 라우팅](/concepts/multi-agent)
- [문제 해결](/channels/troubleshooting)
- [슬래시 명령어](/tools/slash-commands)
