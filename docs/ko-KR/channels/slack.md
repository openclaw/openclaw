---
summary: "Slack 설정 및 런타임 동작 (소켓 모드 + HTTP 이벤트 API)"
read_when:
  - Slack 설정 또는 Slack 소켓/HTTP 모드 디버깅
title: "Slack"
---

# Slack

상태: Slack 앱 통합을 통한 다이렉트 메시지 + 채널에 대해 프로덕션 준비 완료. 기본 모드는 소켓 모드이며, HTTP 이벤트 API 모드도 지원됩니다.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/ko-KR/channels/pairing">
    Slack 다이렉트 메시지는 기본적으로 페어링 모드를 사용합니다.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/ko-KR/tools/slash-commands">
    네이티브 명령어 동작 및 명령어 목록.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/ko-KR/channels/troubleshooting">
    크로스 채널 진단 및 수리 플레이북.
  </Card>
</CardGroup>

## 빠른 설정

<Tabs>
  <Tab title="Socket Mode (기본)">
    <Steps>
      <Step title="Slack 앱 및 토큰 생성">
        Slack 앱 설정에서:

        - **Socket Mode** 활성화
        - `connections:write` 권한의 **App Token** (`xapp-...`) 생성
        - 앱 설치 후 **Bot Token** (`xoxb-...`) 복사
      </Step>

      <Step title="OpenClaw 구성">

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

        환경 변수 대체 (기본 계정만):

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="앱 이벤트 구독">
        봇 이벤트 구독:

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        또한 다이렉트 메시지를 위해 App Home **Messages Tab**을 활성화합니다.
      </Step>

      <Step title="게이트웨이 시작">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="HTTP Events API 모드">
    <Steps>
      <Step title="HTTP를 위한 Slack 앱 설정">

        - 모드를 HTTP로 설정 (`channels.slack.mode="http"`)
        - Slack **Signing Secret** 복사
        - 이벤트 구독 + 상호작용 + Slash 명령어 요청 URL을 동일한 웹훅 경로로 설정 (기본값 `/slack/events`)

      </Step>

      <Step title="OpenClaw HTTP 모드 구성">

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

      <Step title="다중 계정 HTTP에 대해 고유한 웹훅 경로 사용">
        계정별 HTTP 모드를 지원합니다.

        각 계정에 고유한 `webhookPath`를 부여하여 등록 충돌을 방지하십시오.
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 토큰 모델

- `botToken` + `appToken`은 소켓 모드에 필수입니다.
- HTTP 모드는 `botToken` + `signingSecret`이 필요합니다.
- 구성 토큰은 환경 변수 대체보다 우선합니다.
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` 환경 변수 대체는 기본 계정에만 적용됩니다.
- `userToken` (`xoxp-...`)은 구성에서만 사용 가능하며 (환경 변수 대체 없음) 기본적으로 읽기 전용 동작 (`userTokenReadOnly: true`)을 가집니다.
- 선택 사항: 발신 메시지를 활성 에이전트 신원(사용자 정의 `username` 및 아이콘)을 사용하도록 하려면 `chat:write.customize`를 추가하십시오. `icon_emoji`는 `:emoji_name:` 구문을 사용합니다.

<Tip>
작업/디렉토리 읽기에 대해, 사용자 토큰은 구성된 경우 선호될 수 있습니다. 쓰기의 경우, 봇 토큰이 우선으로 남으며, 사용자 토큰으로 쓰기는 `userTokenReadOnly: false`이고 봇 토큰이 없는 경우에만 허용됩니다.
</Tip>

## 접근 제어 및 라우팅

<Tabs>
  <Tab title="DM 정책">
    `channels.slack.dmPolicy`는 DM 접근을 컨트롤합니다 (기존: `channels.slack.dm.policy`):

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`channels.slack.allowFrom`에 `"*"`을 포함해야 함; 기존: `channels.slack.dm.allowFrom`)
    - `disabled`

    DM 플래그:

    - `dm.enabled` (기본값 true)
    - `channels.slack.allowFrom` (선호됨)
    - `dm.allowFrom` (기존)
    - `dm.groupEnabled` (그룹 DM의 기본값 false)
    - `dm.groupChannels` (선택 사항 MPIM allowlist)

    다이렉트 메시지의 페어링은 `openclaw pairing approve slack <code>`를 사용합니다.

  </Tab>

  <Tab title="채널 정책">
    `channels.slack.groupPolicy`는 채널 처리를 제어합니다:

    - `open`
    - `allowlist`
    - `disabled`

    채널 허용 목록은 `channels.slack.channels`에 있습니다.

    런타임 노트: `channels.slack`이 완전히 없고 (환경 변수 설정만 있는 경우) `channels.defaults.groupPolicy`가 설정되지 않은 경우, 런타임은 `groupPolicy="open"`으로 기본값으로 이동하며 경고를 기록합니다.

    이름/ID 해결:

    - 채널 허용 목록 항목 및 DM 허용 목록 항목은 토큰 액세스가 허용할 때 시작 시 해결됩니다
    - 해결되지 않은 항목은 구성된 그대로 유지됩니다

  </Tab>

  <Tab title="멘션 및 채널 사용자">
    채널 메시지는 기본적으로 멘션으로 게이트됩니다.

    멘션 소스:

    - 명시적 앱 멘션 (`<@botId>`)
    - 멘션 정규 표현식 패턴 (`agents.list[].groupChat.mentionPatterns`, 예비 `messages.groupChat.mentionPatterns`)
    - 암시적 봇 스레드에 대한 응답

    채널별 컨트롤 (`channels.slack.channels.<id|name>`):

    - `requireMention`
    - `users` (허용 목록)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## 명령어 및 슬래시 동작

- 네이티브 명령어 자동 모드는 Slack에 대해 **비활성화**되어 있습니다 (`commands.native: "auto"`는 Slack 네이티브 명령어를 활성화하지 않음).
- `channels.slack.commands.native: true` (혹은 글로벌 `commands.native: true`)로 Slack 네이티브 명령어 핸들러를 활성화하세요.
- 네이티브 명령어가 활성화되면, Slack에 일치하는 슬래시 명령어를 등록하세요 (`/<command>` 이름).
- 네이티브 명령어가 활성화되지 않은 경우, `channels.slack.slashCommand`를 통해 단일 구성된 슬래시 명령어를 실행할 수 있습니다.
- 네이티브 인수 메뉴는 다음과 같이 렌더링 전략에 적응합니다:
  - 최대 5개 옵션: 버튼 블록
  - 6-100개 옵션: 정적 선택 메뉴
  - 100개를 초과하는 옵션: 상호작용 옵션 핸들러가 있는 경우 비동기 옵션 필터링과 함께 외부 선택 사용
  - 인코딩된 옵션 값이 Slack 제한을 초과할 경우, 흐름은 버튼으로 되돌아갑니다
- 긴 옵션 페이로드에 대해, 슬래시 명령어 매개변수 메뉴는 값을 선택하기 전에 확인 대화를 사용합니다.

기본 슬래시 명령어 설정:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

슬래시 세션은 격리된 키를 사용합니다:

- `agent:<agentId>:slack:slash:<userId>`

그리고 여전히 대상 대화 세션에 대해 명령어 실행을 라우팅합니다 (`CommandTargetSessionKey`).

## 쓰레딩, 세션 및 응답 태그

- 다이렉트 메시지는 `direct`로 라우팅되고, 채널은 `channel`, MPIM은 `group`으로 라우팅됩니다.
- 기본 `session.dmScope=main`으로, Slack 다이렉트 메시지는 에이전트 메인 세션에 통합됩니다.
- 채널 세션: `agent:<agentId>:slack:channel:<channelId>`.
- 스레드 응답은 경우에 따라 스레드 세션 접미사 (`:thread:<threadTs>`)를 생성할 수 있습니다.
- `channels.slack.thread.historyScope` 기본값은 `thread`; `thread.inheritParent` 기본값은 `false`입니다.
- `channels.slack.thread.initialHistoryLimit`는 새 스레드 세션이 시작될 때 가져올 기존 스레드 메시지 수를 제어합니다 (기본값 `20`; 비활성화하려면 `0`으로 설정).

응답 쓰레딩 제어:

- `channels.slack.replyToMode`: `off|first|all` (기본값 `off`)
- `channels.slack.replyToModeByChatType`: `direct|group|channel`별
- 다이렉트 채팅에 대한 기존 대체: `channels.slack.dm.replyToMode`

수동 응답 태그가 지원됩니다:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

참고: `replyToMode="off"`는 암시적 응답 쓰레딩을 비활성화합니다. 명시적 `[[reply_to_*]]` 태그는 여전히 허용됩니다.

## 미디어, 청킹 및 전달

<AccordionGroup>
  <Accordion title="수신 첨부 파일">
    Slack 파일 첨부 파일은 Slack에서 호스팅되는 개인 URL에서 다운로드되며 (토큰 인증이 필요한 요청 흐름), 가져오기가 성공하고 사이즈 제한이 허용되는 경우 미디어 저장소에 저장됩니다.

    런타임 수신 크기 제한 기본값은 `20MB`이며, `channels.slack.mediaMaxMb`로 재정의할 수 있습니다.

  </Accordion>

  <Accordion title="발신 텍스트 및 파일">
    - 텍스트 청크는 `channels.slack.textChunkLimit`를 사용합니다 (기본값 4000)
    - `channels.slack.chunkMode="newline"`은 단락 우선 분할을 활성화합니다
    - 파일 전송은 Slack 업로드 API를 사용하며 스레드 응답을 포함할 수 있습니다 (`thread_ts`)
    - 발신 미디어 제한은 설정된 경우 `channels.slack.mediaMaxMb`를 따르며, 그렇지 않으면 미디어 파이프라인의 MIME 종류 기본 값을 사용
  </Accordion>

  <Accordion title="전달 대상">
    선호하는 명시적 대상:

    - 다이렉트 메시지는 `user:<id>`
    - 채널은 `channel:<id>`

    Slack 다이렉트 메시지는 사용자 대상에 전송할 때 Slack 대화 API를 통해 열립니다.

  </Accordion>
</AccordionGroup>

## 조작 및 게이트

Slack 조작은 `channels.slack.actions.*`로 제어됩니다.

현재 Slack 도구의 사용 가능한 조작 그룹:

| 그룹       | 기본값  |
| ---------- | ------- |
| messages   | enabled |
| reactions  | enabled |
| pins       | enabled |
| memberInfo | enabled |
| emojiList  | enabled |

## 이벤트 및 운영 행동

- 메시지 수정/삭제/스레드 방송은 시스템 이벤트로 매핑됩니다.
- 반응 추가/삭제 이벤트는 시스템 이벤트로 매핑됩니다.
- 멤버 가입/탈퇴, 채널 생성/이름 변경, 핀 추가/제거 이벤트는 시스템 이벤트로 매핑됩니다.
- 어시스턴트 스레드 상태 업데이트 (스레드에서 "입력 중..." 표시기용)는 `assistant.threads.setStatus`를 사용하며 봇 범위 `assistant:write`가 필요합니다.
- `channel_id_changed`는 `configWrites`가 활성화되었을 때 채널 구성 키를 마이그레이션할 수 있습니다.
- 채널 주제/목적 메타데이터는 신뢰할 수 없는 컨텍스트로 취급되며 라우팅 컨텍스트에 주입될 수 있습니다.
- 블록 작업 및 모달 상호작용은 구조화된 `Slack interaction: ...` 시스템 이벤트와 풍부한 페이로드 필드를 방출합니다:
  - 블록 작업: 선택한 값, 레이블, 선택자 값, `workflow_*` 메타데이터
  - 모달 `view_submission` 및 `view_closed` 이벤트는 라우팅된 채널 메타데이터 및 양식 입력과 함께 제공됩니다.

## Ack 반응

`ackReaction`은 OpenClaw가 수신 메시지를 처리하는 동안 수신 확인 이모지를 보냅니다.

해결 순서:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- 에이전트 신원 이모지 대체 (`agents.list[].identity.emoji`, 없으면 "👀")

참고:

- Slack은 쇼트코드 (예: `"eyes"`)를 기대합니다.
- 채널이나 계정에 대해 반응을 비활성화하려면 `""`를 사용하세요.

## 매니페스트 및 범위 체크리스트

<AccordionGroup>
  <Accordion title="Slack 앱 매니페스트 예">

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
        "assistant:write",
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

  <Accordion title="선택적 사용자 토큰 범위 (읽기 작업)">
    `channels.slack.userToken`을 구성하는 경우, 전형적인 읽기 범위는 다음과 같습니다:

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
  <Accordion title="채널에서 답장이 없음">
    확인할 사항, 순서대로:

    - `groupPolicy`
    - 채널 허용 목록 (`channels.slack.channels`)
    - `requireMention`
    - 채널별 `users` 허용 목록

    유용한 명령어:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="DM 메시지 무시됨">
    확인할 사항:

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy` (또는 기존 `channels.slack.dm.policy`)
    - 페어링 승인 및 허용 목록 항목

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="소켓 모드 연결 안됨">
    Slack 앱 설정에서 봇 및 앱 토큰과 소켓 모드 활성화를 검증하십시오.
  </Accordion>

  <Accordion title="HTTP 모드에서 이벤트 수신 안됨">
    검증할 사항:

    - 서명 비밀
    - 웹훅 경로
    - Slack 요청 URL (이벤트 + 상호작용 + 슬래시 명령어)
    - HTTP 계정별 고유한 `webhookPath`

  </Accordion>

  <Accordion title="네이티브/슬래시 명령어 실행 안됨">
    다음 중 의도된 작업인지 확인하십시오:

    - 슬랙에 일치하는 슬래시 명령을 등록하는 네이티브 명령 모드 (`channels.slack.commands.native: true`)
    - 또는 단일 슬래시 명령 모드 (`channels.slack.slashCommand.enabled: true`)

    또한 `commands.useAccessGroups` 및 채널/사용자 허용 목록을 확인하십시오.

  </Accordion>
</AccordionGroup>

## 텍스트 스트리밍

OpenClaw는 Agents and AI Apps API를 통해 Slack 네이티브 텍스트 스트리밍을 지원합니다.

`channels.slack.streaming`은 실시간 미리보기 동작을 제어합니다:

- `off`: 실시간 미리보기 스트리밍 비활성화.
- `partial` (기본값): 미리보기 텍스트를 최신 부분 출력으로 교체.
- `block`: 청크된 미리보기 업데이트를 추가.
- `progress`: 생성 중에 진행 상태 텍스트를 표시하고 최종 텍스트를 전송.

`channels.slack.nativeStreaming`은 `streaming`이 `partial`일 때 Slack의 네이티브 스트리밍 API (`chat.startStream` / `chat.appendStream` / `chat.stopStream`)를 제어합니다 (기본값: `true`).

네이티브 Slack 스트리밍 비활성화 (초안 미리보기 동작 유지):

```yaml
channels:
  slack:
    streaming: partial
    nativeStreaming: false
```

레거시 키:

- `channels.slack.streamMode` (`replace | status_final | append`)는 `channels.slack.streaming`으로 자동 마이그레이션됩니다.
- boolean `channels.slack.streaming`은 `channels.slack.nativeStreaming`으로 자동 마이그레이션됩니다.

### Requirements

1. Slack 앱 설정에서 **Agents and AI Apps**를 활성화합니다.
2. 앱에 `assistant:write` 범위가 있는지 확인합니다.
3. 해당 메시지에 사용할 수 있는 응답 스레드가 있어야 합니다. 스레드 선택은 여전히 `replyToMode`를 따릅니다.

### Behavior

- 첫 번째 텍스트 청크는 스트림을 시작합니다 (`chat.startStream`).
- 나중 텍스트 청크는 동일한 스트림에 추가됩니다 (`chat.appendStream`).
- 응답 종료는 스트림을 완료합니다 (`chat.stopStream`).
- 미디어 및 텍스트가 아닌 페이로드는 일반 전달로 대체됩니다.
- 스트리밍이 응답 중 실패하면, OpenClaw는 나머지 페이로드에 대해 일반 전달로 대체됩니다.

## 구성 참조 포인터

주요 참조:

- [구성 참조 - Slack](/ko-KR/gateway/configuration-reference#slack)

  신호 강도가 높은 Slack 필드:
  - 모드/인증: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
  - DM 접근: `dm.enabled`, `dmPolicy`, `allowFrom` (기존: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
  - 채널 접근: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
  - 쓰레딩/히스토리: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
  - 전달: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `streaming`, `nativeStreaming`
  - 운영/기능: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## 관련 항목

- [Pairing](/ko-KR/channels/pairing)
- [채널 라우팅](/ko-KR/channels/channel-routing)
- [문제 해결](/ko-KR/channels/troubleshooting)
- [구성](/ko-KR/gateway/configuration)
- [슬래시 명령어](/ko-KR/tools/slash-commands)
