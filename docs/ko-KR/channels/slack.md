---
summary: "Slack setup and runtime behavior (Socket Mode + HTTP Events API)"
read_when:
  - Setting up Slack or debugging Slack socket/HTTP mode
title: "Slack"
x-i18n:
  source_hash: 5ef37f0cb9d8f7a828494acc1e76930666260cc8da6e9ff12a332001a36331a8
---

# 슬랙

상태: Slack 앱 통합을 통해 DM + 채널에 대한 프로덕션 준비가 완료되었습니다. 기본 모드는 소켓 모드입니다. HTTP 이벤트 API 모드도 지원됩니다.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Slack DM은 기본적으로 페어링 모드로 설정됩니다.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    기본 명령 동작 및 명령 카탈로그.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    교차 채널 진단 및 수리 플레이북.
  </Card>
</CardGroup>

## 빠른 설정

<Tabs>
  <Tab title="Socket Mode (default)">
    <Steps>
      <Step title="Create Slack app and tokens">
        Slack 앱 설정에서:

        - **소켓 모드** 활성화
        - `connections:write`를 사용하여 **앱 토큰**(`xapp-...`)을 생성합니다.
        - 앱 설치 및 **봇 토큰** 복사(`xoxb-...`)
      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

        환경 대체(기본 계정만 해당):

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="Subscribe app events">
        다음에 대한 봇 이벤트를 구독하세요:

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        DM용 앱 홈 **메시지 탭**도 활성화하세요.
      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP Events API mode">
    <Steps>
      <Step title="Configure Slack app for HTTP">

        - 모드를 HTTP로 설정합니다. (`channels.slack.mode="http"`)
        - Slack **서명 비밀** 복사
        - 이벤트 구독 + 상호작용 + 슬래시 명령 요청 URL을 동일한 웹훅 경로로 설정합니다(기본값 `/slack/events`).

      </Step>

      <Step title="Configure OpenClaw HTTP mode">

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

      </Step>

      <Step title="Use unique webhook paths for multi-account HTTP">
        계정별 HTTP 모드가 지원됩니다.

        등록이 충돌하지 않도록 각 계정에 고유한 `webhookPath`를 부여하십시오.
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 토큰 모델

- 소켓 모드에는 `botToken` + `appToken`가 필요합니다.
- HTTP 모드에는 `botToken` + `signingSecret`가 필요합니다.
- 구성 토큰은 환경 대체를 재정의합니다.
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` env fallback은 기본 계정에만 적용됩니다.
- `userToken` (`xoxp-...`)는 구성 전용(환경 폴백 없음)이며 기본적으로 읽기 전용 동작(`userTokenReadOnly: true`)입니다.

<Tip>
작업/디렉터리 읽기의 경우 구성 시 사용자 토큰이 선호될 수 있습니다. 쓰기의 경우 봇 토큰이 선호됩니다. 사용자 토큰 쓰기는 `userTokenReadOnly: false` 및 봇 토큰을 사용할 수 없는 경우에만 허용됩니다.
</Tip>

## 액세스 제어 및 라우팅

<Tabs>
  <Tab title="DM policy">
    `channels.slack.dm.policy`는 DM 액세스를 제어합니다.

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`"*"`을 포함하려면 `dm.allowFrom` 필요)
    - `disabled`

    DM 플래그:

    - `dm.enabled` (기본값은 true)
    - `dm.allowFrom`
    - `dm.groupEnabled` (그룹 DM 기본 false)
    - `dm.groupChannels` (선택적 MPIM 허용 목록)

    DM의 페어링은 `openclaw pairing approve slack <code>`를 사용합니다.

  </Tab>

<Tab title="Channel policy">
    `channels.slack.groupPolicy`는 채널 처리를 제어합니다.

    - `open`
    - `allowlist`
    - `disabled`

    채널 허용 목록은 `channels.slack.channels`에 있습니다.

    런타임 참고: `channels.slack`가 완전히 누락되고(env 전용 설정) `channels.defaults.groupPolicy`가 설정되지 않은 경우 런타임은 `groupPolicy="open"`로 돌아가고 경고를 기록합니다.

    이름/ID 확인:

    - 토큰 액세스가 허용되면 시작 시 채널 허용 목록 항목 및 DM 허용 목록 항목이 해결됩니다.
    - 해결되지 않은 항목은 구성된 대로 유지됩니다.

  </Tab>

  <Tab title="Mentions and channel users">
    채널 메시지는 기본적으로 멘션 제한됩니다.

    출처 언급:

    - 명시적인 앱 언급(`<@botId>`)
    - 정규식 패턴 언급(`agents.list[].groupChat.mentionPatterns`, 대체 `messages.groupChat.mentionPatterns`)
    - 암시적 봇에 대한 응답 스레드 동작

    채널별 제어(`channels.slack.channels.<id|name>`):

    - `requireMention`
    - `users` (허용 목록)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## 명령 및 슬래시 동작

- Slack의 경우 기본 명령 자동 모드가 **꺼져** 있습니다(`commands.native: "auto"`는 Slack 기본 명령을 활성화하지 않습니다).
- `channels.slack.commands.native: true`(또는 전역 `commands.native: true`)를 사용하여 기본 Slack 명령 처리기를 활성화합니다.
- 기본 명령어가 활성화되면 일치하는 슬래시 명령어를 Slack(`/<command>` 이름)에 등록합니다.
- 기본 명령이 활성화되지 않은 경우 `channels.slack.slashCommand`를 통해 구성된 단일 슬래시 명령을 실행할 수 있습니다.

기본 슬래시 명령 설정:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

슬래시 세션은 격리된 키를 사용합니다.

- `agent:<agentId>:slack:slash:<userId>`

여전히 대상 대화 세션(`CommandTargetSessionKey`)에 대해 명령 실행을 라우팅합니다.

## 스레딩, 세션 및 응답 태그

- DM 경로는 `direct`입니다. 채널은 `channel`로; MPIM은 `group`입니다.
- 기본값 `session.dmScope=main`을 사용하면 Slack DM이 에이전트 기본 세션으로 축소됩니다.
- 채널 세션: `agent:<agentId>:slack:channel:<channelId>`.
- 스레드 응답은 해당되는 경우 스레드 세션 접미사(`:thread:<threadTs>`)를 생성할 수 있습니다.
- `channels.slack.thread.historyScope` 기본값은 `thread`입니다. `thread.inheritParent` 기본값은 `false`입니다.
- `channels.slack.thread.initialHistoryLimit`는 새 스레드 세션이 시작될 때 가져오는 기존 스레드 메시지 수를 제어합니다(기본값 `20`; 비활성화하려면 `0` 설정).

응답 스레딩 제어:

- `channels.slack.replyToMode`: `off|first|all` (기본값 `off`)
- `channels.slack.replyToModeByChatType`: `direct|group|channel` 당
- 직접 채팅에 대한 레거시 대체: `channels.slack.dm.replyToMode`

수동 회신 태그가 지원됩니다.

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

## 미디어, 청킹 및 전달

<AccordionGroup>
  <Accordion title="Inbound attachments">
    Slack 파일 첨부는 Slack 호스팅 개인 URL(토큰 인증 요청 흐름)에서 다운로드되고 가져오기가 성공하고 크기 제한이 허용되면 미디어 저장소에 기록됩니다.

    런타임 인바운드 크기 한도는 `channels.slack.mediaMaxMb`로 재정의되지 않는 한 기본값은 `20MB`입니다.

  </Accordion>

<Accordion title="Outbound text and files">
    - 텍스트 청크는 `channels.slack.textChunkLimit`를 사용합니다(기본값 4000).
    - `channels.slack.chunkMode="newline"` 단락 우선 분할을 활성화합니다.
    - 파일 전송은 Slack 업로드 API를 사용하며 스레드 응답을 포함할 수 있습니다. (`thread_ts`)
    - 구성된 경우 아웃바운드 미디어 캡은 `channels.slack.mediaMaxMb`을 따릅니다. 그렇지 않으면 채널 전송은 미디어 파이프라인의 MIME 종류 기본값을 사용합니다.
  </Accordion>

  <Accordion title="Delivery targets">
    선호하는 명시적 대상:

    - DM의 경우 `user:<id>`
    - `channel:<id>` 채널용

    Slack DM은 사용자 대상으로 보낼 때 Slack 대화 API를 통해 열립니다.

  </Accordion>
</AccordionGroup>

## 액션과 게이트

Slack 작업은 `channels.slack.actions.*`에 의해 제어됩니다.

현재 Slack 도구에서 사용 가능한 작업 그룹:

| 그룹          | 기본값 |
| ------------- | ------ |
| 메시지        | 활성화 |
| 반응          | 활성화 |
| 핀            | 활성화 |
| 회원정보      | 활성화 |
| 이모티콘 목록 | 활성화 |

## 이벤트 및 운영 동작

- 메시지 편집/삭제/스레드 브로드캐스트는 시스템 이벤트에 매핑됩니다.
- 반응 추가/제거 이벤트는 시스템 이벤트에 매핑됩니다.
- 회원 가입/탈퇴, 채널 생성/이름 변경, 핀 추가/제거 이벤트가 시스템 이벤트에 매핑됩니다.
- `channel_id_changed`는 `configWrites`가 활성화되면 채널 구성 키를 마이그레이션할 수 있습니다.
- 채널 주제/목적 메타데이터는 신뢰할 수 없는 컨텍스트로 처리되며 라우팅 컨텍스트에 삽입될 수 있습니다.

## 매니페스트 및 범위 체크리스트

<AccordionGroup>
  <Accordion title="Slack app manifest example">

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
        "im:history",
        "mpim:history",
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

  </Accordion>

  <Accordion title="Optional user-token scopes (read operations)">
    `channels.slack.userToken`를 구성하는 경우 일반적인 읽기 범위는 다음과 같습니다.

    - `channels:history`, `groups:history`, `im:history`, `mpim:history`
    - `channels:read`, `groups:read`, `im:read`, `mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read` (Slack 검색 읽기에 의존하는 경우)

  </Accordion>
</AccordionGroup>

## 문제 해결

<AccordionGroup>
  <Accordion title="No replies in channels">
    순서대로 확인하세요.

    - `groupPolicy`
    - 채널 허용 목록(`channels.slack.channels`)
    - `requireMention`
    - 채널별 `users` 허용 목록

    유용한 명령:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="DM messages ignored">
    확인:

    - `channels.slack.dm.enabled`
    - `channels.slack.dm.policy`
    - 페어링 승인/허용 목록 항목

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode not connecting">
    Slack 앱 설정에서 봇 + 앱 토큰 및 소켓 모드 활성화를 확인하세요.
  </Accordion>

  <Accordion title="HTTP mode not receiving events">
    검증:

    - 서명 비밀
    - 웹훅 경로
    - Slack 요청 URL(이벤트 + 상호작용 + 슬래시 명령)
    - HTTP 계정당 고유한 `webhookPath`

  </Accordion>

  <Accordion title="Native/slash commands not firing">
    다음을 의도했는지 확인하십시오.

    - Slack에 등록된 슬래시 명령과 일치하는 기본 명령 모드(`channels.slack.commands.native: true`)
    - 또는 단일 슬래시 명령 모드(`channels.slack.slashCommand.enabled: true`)

    또한 `commands.useAccessGroups` 및 채널/사용자 허용 목록을 확인하세요.

  </Accordion>
</AccordionGroup>

## 구성 참조 포인터

기본 참조:

- [구성 참조 - Slack](/gateway/configuration-reference#slack)

신호가 높은 Slack 필드:

- 모드/인증: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM 접속: `dm.enabled`, `dm.policy`, `dm.allowFrom`, `dm.groupEnabled`, `dm.groupChannels`
- 채널 접근: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- 스레딩/이력: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 배송: `textChunkLimit`, `chunkMode`, `mediaMaxMb`
- 작전/기능: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [문제 해결](/channels/troubleshooting)
- [구성](/gateway/configuration)
- [슬래시 명령](/tools/slash-commands)
