---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord channel features
title: "Discord"
x-i18n:
  source_hash: d8eca19db2f29f6c53c00e32520ef35d1b291056c844f5b9bcaaafc904cdd5ea
---

# 디스코드(봇 API)

상태: 공식 Discord 게이트웨이를 통해 DM 및 길드 채널을 사용할 준비가 되었습니다.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Discord DM은 기본적으로 페어링 모드로 설정됩니다.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    기본 명령 동작 및 명령 카탈로그.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    채널 간 진단 및 수리 흐름.
  </Card>
</CardGroup>

## 빠른 설정

<Steps>
  <Step title="Create a Discord bot and enable intents">
    Discord 개발자 포털에서 애플리케이션을 생성하고 봇을 추가한 후 다음을 활성화하세요.

    - **메시지 내용 의도**
    - **서버 구성원 의도**(역할 허용 목록 및 역할 기반 라우팅에 필요, 이름-ID 허용 목록 일치에 권장)

  </Step>

  <Step title="Configure token">

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

    기본 계정에 대한 환경 대체:

```bash
DISCORD_BOT_TOKEN=...
```

  </Step>

  <Step title="Invite the bot and start gateway">
    메시지 권한으로 봇을 서버에 초대하세요.

```bash
openclaw gateway
```

  </Step>

  <Step title="Approve first DM pairing">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

    페어링 코드는 1시간 후에 만료됩니다.

  </Step>
</Steps>

<Note>
토큰 확인은 계정을 인식합니다. 구성 토큰 값은 환경 폴백보다 우선합니다. `DISCORD_BOT_TOKEN`는 기본 계정에만 사용됩니다.
</Note>

## 런타임 모델

- 게이트웨이는 Discord 연결을 소유합니다.
- 회신 라우팅은 결정적입니다. Discord 인바운드는 Discord에 다시 응답합니다.
- 기본적으로(`session.dmScope=main`) 직접 채팅은 에이전트 기본 세션(`agent:main:main`)을 공유합니다.
- 길드 채널은 분리된 세션 키입니다(`agent:<agentId>:discord:channel:<channelId>`).
- 그룹 DM은 기본적으로 무시됩니다(`channels.discord.dm.groupEnabled=false`).
- 기본 슬래시 명령은 격리된 명령 세션(`agent:<agentId>:discord:slash:<userId>`)에서 실행되는 동시에 라우팅된 대화 세션에 `CommandTargetSessionKey`를 전달합니다.

## 액세스 제어 및 라우팅

<Tabs>
  <Tab title="DM policy">
    `channels.discord.dm.policy`는 DM 액세스를 제어합니다.

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`"*"`를 포함하려면 `channels.discord.dm.allowFrom` 필요)
    - `disabled`

    DM 정책이 열려 있지 않으면 알 수 없는 사용자가 차단됩니다(또는 `pairing` 모드에서 페어링하라는 메시지가 표시됨).

    배송을 위한 DM 대상 형식:

    - `user:<id>`
    - `<@id>` 언급

    명시적인 사용자/채널 대상 종류가 제공되지 않는 한 단순 숫자 ID는 모호하며 거부됩니다.

  </Tab>

  <Tab title="Guild policy">
    길드 처리는 `channels.discord.groupPolicy`에 의해 제어됩니다:

    - `open`
    - `allowlist`
    - `disabled`

    `channels.discord`이 존재할 때의 보안 기준은 `allowlist`입니다.

    `allowlist` 행동:

    - 길드는 `channels.discord.guilds`와 일치해야 합니다(`id` 선호, 슬러그 허용).
    - 선택적 발신자 허용 목록: `users`(ID 또는 이름) 및 `roles`(역할 ID만) 둘 중 하나가 구성된 경우 `users` 또는 `roles`와 일치하면 발신자가 허용됩니다.
    - 길드에 `channels`가 설정되어 있는 경우 목록에 없는 채널은 거부됩니다.
    - 길드에 `channels` 블록이 없으면 허용된 길드의 모든 채널이 허용됩니다.

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

`DISCORD_BOT_TOKEN`만 설정하고 `channels.discord` 블록을 생성하지 않으면 런타임 폴백은 `groupPolicy="open"`입니다(로그에 경고 표시).

  </Tab>

  <Tab title="Mentions and group DMs">
    길드 메시지는 기본적으로 멘션 게이트로 처리됩니다.

    멘션 감지에는 다음이 포함됩니다.

    - 명시적인 봇 언급
    - 구성된 멘션 패턴(`agents.list[].groupChat.mentionPatterns`, 대체 `messages.groupChat.mentionPatterns`)
    - 지원되는 경우 암시적인 봇에 대한 응답 동작

    `requireMention`는 길드/채널별로 구성됩니다(`channels.discord.guilds...`).

    그룹 DM:

    - 기본값: 무시됨 (`dm.groupEnabled=false`)
    - `dm.groupChannels`를 통한 선택적 허용 목록(채널 ID 또는 슬러그)

  </Tab>
</Tabs>

### 역할 기반 상담원 라우팅

`bindings[].match.roles`를 사용하여 Discord 길드원을 역할 ID별로 다른 에이전트에게 라우팅할 수 있습니다. 역할 기반 바인딩은 역할 ID만 허용하며 피어 또는 상위-피어 바인딩 이후, 길드 전용 바인딩 이전에 평가됩니다.

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

## 개발자 포털 설정

<AccordionGroup>
  <Accordion title="Create app and bot">

    1. Discord 개발자 포털 -> **애플리케이션** -> **새 애플리케이션**
    2. **봇** -> **봇 추가**
    3. 봇 토큰 복사

  </Accordion>

  <Accordion title="Privileged intents">
    **Bot -> Privileged Gateway Intents**에서 다음을 활성화합니다.

    - 메시지 내용의 의도
    - 서버 구성원 의도(권장)

    현재 상태 의도는 선택 사항이며 현재 상태 업데이트를 받으려는 경우에만 필요합니다. 봇 존재 여부 설정(`setPresence`)에는 구성원에 대한 현재 상태 업데이트를 활성화할 필요가 없습니다.

  </Accordion>

  <Accordion title="OAuth scopes and baseline permissions">
    OAuth URL 생성기:

    - 범위: `bot`, `applications.commands`

    일반적인 기본 권한:

    - 채널 보기
    - 메시지 보내기
    - 메시지 기록 읽기
    - 링크 삽입
    - 파일 첨부
    - 반응 추가(선택 사항)

    명시적으로 필요한 경우가 아니면 `Administrator`를 사용하지 마세요.

  </Accordion>

  <Accordion title="Copy IDs">
    Discord 개발자 모드를 활성화한 후 다음을 복사하세요.

    - 서버 ID
    - 채널 ID
    - 사용자 ID

    안정적인 감사 및 프로브를 위해 OpenClaw 구성에서 숫자 ID를 선호합니다.

  </Accordion>
</AccordionGroup>

## 기본 명령 및 명령 인증

- `commands.native`의 기본값은 `"auto"`이며 Discord에서 활성화됩니다.
- 채널별 재정의: `channels.discord.commands.native`.
- `commands.native=false`는 이전에 등록된 Discord 네이티브 명령어를 명시적으로 삭제합니다.
- 기본 명령 auth는 일반 메시지 처리와 동일한 Discord 허용 목록/정책을 사용합니다.
- 승인되지 않은 사용자의 경우 Discord UI에 명령이 계속 표시될 수 있습니다. 실행은 여전히 ​​OpenClaw 인증을 시행하고 "승인되지 않음"을 반환합니다.

명령 카탈로그 및 동작은 [슬래시 명령](/tools/slash-commands)을 참조하세요.

## 기능 세부정보

<AccordionGroup>
  <Accordion title="Reply tags and native replies">
    Discord는 상담원 출력에서 응답 태그를 지원합니다.

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    `channels.discord.replyToMode`에 의해 제어됨:

    - `off` (기본값)
    - `first`
    - `all`

    메시지 ID는 컨텍스트/기록에 표시되므로 상담원이 특정 메시지를 타겟팅할 수 있습니다.

  </Accordion>

  <Accordion title="History, context, and thread behavior">
    길드 역사 내용:

    - `channels.discord.historyLimit` 기본값 `20`
    - 대체: `messages.groupChat.historyLimit`
    - `0` 비활성화

    DM 기록 제어:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    스레드 동작:

    - Discord 스레드는 채널 세션으로 라우팅됩니다.
    - 상위 스레드 메타데이터는 상위 세션 연결에 사용될 수 있습니다.
    - 스레드 특정 항목이 존재하지 않는 한 스레드 구성은 상위 채널 구성을 상속합니다.

    채널 주제는 **신뢰할 수 없는** 컨텍스트(시스템 프롬프트가 아님)로 삽입됩니다.

  </Accordion>

  <Accordion title="Reaction notifications">
    길드별 반응 알림 모드:

    - `off`
    - `own` (기본값)
    - `all`
    - `allowlist` (`guilds.<id>.users` 사용)

    반응 이벤트는 시스템 이벤트로 전환되어 라우팅된 Discord 세션에 첨부됩니다.

  </Accordion>

  <Accordion title="Config writes">
    채널 시작 구성 쓰기는 기본적으로 활성화됩니다.

    이는 `/config set|unset` 흐름에 영향을 미칩니다(명령 기능이 활성화된 경우).

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

  <Accordion title="PluralKit support">
    PluralKit 확인을 활성화하여 프록시 메시지를 시스템 구성원 ID에 매핑합니다.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; needed for private systems
      },
    },
  },
}
```

    참고:

    - 허용 목록은 `pk:<memberId>`를 사용할 수 있습니다.
    - 멤버 표시 이름은 이름/슬러그와 일치합니다.
    - 조회는 원본 메시지 ID를 사용하며 기간이 제한되어 있습니다.
    - 조회가 실패하면 프록시 메시지는 봇 메시지로 처리되어 `allowBots=true`가 아닌 이상 삭제됩니다.

  </Accordion>

  <Accordion title="Exec approvals in Discord">
    Discord는 DM에서 버튼 기반 실행 승인을 지원합니다.

    구성 경로:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    알 수 없는 승인 ID로 승인이 실패하는 경우 승인자 목록 및 기능 활성화를 확인하세요.

    관련 문서: [실행 승인](/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## 도구 및 액션 게이트

Discord 메시지 작업에는 메시징, 채널 관리, 중재, 현재 상태 및 메타데이터 작업이 포함됩니다.

핵심 예:

- 메시지: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- 반응: `react`, `reactions`, `emojiList`
- 중재: `timeout`, `kick`, `ban`
- 존재: `setPresence`

액션 게이트는 `channels.discord.actions.*` 아래에 있습니다.

기본 게이트 동작:

| 액션 그룹                                                                                                                                        | 기본값 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 반응, 메시지, 스레드, 핀, 여론 조사, 검색, memberInfo, roleInfo, 채널 정보, 채널, voiceStatus, 이벤트, 스티커, emojiUploads, 스티커 업로드, 권한 | 활성화 |
| 역할                                                                                                                                             | 장애인 |
| 절제                                                                                                                                             | 장애인 |
| 존재                                                                                                                                             | 장애인 |

## 문제 해결

<AccordionGroup>
  <Accordion title="Used disallowed intents or bot sees no guild messages">

    - 메시지 콘텐츠 의도 활성화
    - 사용자/멤버 해결에 의존하는 경우 서버 멤버 의도를 활성화합니다.
    - 의도 변경 후 게이트웨이 다시 시작

  </Accordion>

  <Accordion title="Guild messages blocked unexpectedly">

    - `groupPolicy` 확인
    - `channels.discord.guilds`에서 길드 허용 목록을 확인하세요.
    - 길드 `channels` 맵이 존재하는 경우, 나열된 채널만 허용됩니다.
    - `requireMention` 행동 및 언급 패턴을 확인합니다.

    유용한 점검 사항:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Require mention false but still blocked">
    일반적인 원인:

    - `groupPolicy="allowlist"` 길드/채널 허용 목록이 일치하지 않음
    - `requireMention`가 잘못된 위치에 구성되었습니다(`channels.discord.guilds` 또는 채널 항목 아래에 있어야 함).
    - 길드/채널 `users` 허용 목록에 의해 차단된 발신자

  </Accordion>

  <Accordion title="Permissions audit mismatches">
    `channels status --probe` 권한 확인은 숫자 채널 ID에 대해서만 작동합니다.

    슬러그 키를 사용하는 경우 런타임 일치는 계속 작동할 수 있지만 프로브는 권한을 완전히 확인할 수 없습니다.

  </Accordion>

  <Accordion title="DM and pairing issues">

    - DM 비활성화: `channels.discord.dm.enabled=false`
    - DM 정책 비활성화: `channels.discord.dm.policy="disabled"`
    - `pairing` 모드에서 페어링 승인 대기 중

  </Accordion>

  <Accordion title="Bot to bot loops">
    기본적으로 봇이 작성한 메시지는 무시됩니다.

    `channels.discord.allowBots=true`를 설정한 경우 루프 동작을 방지하려면 엄격한 멘션 및 허용 목록 규칙을 사용하세요.

  </Accordion>
</AccordionGroup>

## 구성 참조 포인터

기본 참조:

- [구성 참고 - 디스코드](/gateway/configuration-reference#discord)

신호가 높은 Discord 필드:

- 시작/인증: `enabled`, `token`, `accounts.*`, `allowBots`
- 정책: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- 명령: `commands.native`, `commands.useAccessGroups`, `configWrites`
- 답글/기록: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 배송: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- 미디어/재시도: `mediaMaxMb`, `retry`
- 행동: `actions.*`
- 기능: `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## 안전 및 운영

- 봇 토큰을 비밀로 취급합니다(감독 환경에서는 `DISCORD_BOT_TOKEN` 선호).
- 최소 권한의 Discord 권한을 부여하세요.
- 명령 배포/상태가 오래되면 게이트웨이를 다시 시작하고 `openclaw channels status --probe`로 다시 확인하세요.

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [문제 해결](/channels/troubleshooting)
- [슬래시 명령](/tools/slash-commands)
