---
summary: "Slack 설정 및 런타임 동작 (Socket Mode + HTTP Events API)"
read_when:
  - Slack 채널 설정 또는 Slack 소켓/HTTP 모드 디버깅 중
title: "Slack"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/channels/slack.md"
  workflow: 15
---

# Slack

상태: Socket Mode + HTTP Events API를 통한 DM 및 채널용 프로덕션 준비 완료. 기본 모드는 Socket Mode; HTTP Events API 모드도 지원됩니다.

<CardGroup cols={3}>
  <Card title="페어링" icon="link" href="/channels/pairing">
    Slack DM은 기본적으로 페어링 모드입니다.
  </Card>
  <Card title="슬래시 명령어" icon="terminal" href="/tools/slash-commands">
    기본 명령어 동작 및 명령어 카탈로그.
  </Card>
  <Card title="채널 문제 해결" icon="wrench" href="/channels/troubleshooting">
    채널 간 진단 및 복구 매뉴얼.
  </Card>
</CardGroup>

## 빠른 설정

<Tabs>
  <Tab title="Socket Mode (기본값)">
    <Steps>
      <Step title="Slack 앱 및 토큰 만들기">
        Slack 앱 설정에서:

        - **Socket Mode** 활성화
        - **앱 토큰** (`xapp-...`) with `connections:write` 만들기
        - 앱 설치 및 **봇 토큰** (`xoxb-...`) 복사

      </Step>

      <Step title="OpenClaw 설정">

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

        환경 변수 폴백 (기본 계정만):

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="앱 이벤트 구독">
        다음 봇 이벤트를 구독:

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        또한 앱 홈 **메시지 탭**을 DM에 대해 활성화합니다.

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
      <Step title="HTTP에 대해 Slack 앱 설정">

        - 모드를 HTTP (`channels.slack.mode="http"`)로 설정
        - Slack **서명 비밀** 복사
        - 동일한 웹훅 경로로 Event Subscriptions + Interactivity + Slash 명령어 Request URL 설정 (기본값 `/slack/events`)

      </Step>

      <Step title="OpenClaw HTTP 모드 설정">

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

      <Step title="다중 계정 HTTP용 고유 웹훅 경로 사용">
        계정별 HTTP 모드가 지원됩니다.

        각 계정에 고유한 `webhookPath`를 제공하여 등록이 충돌하지 않도록 합니다.

      </Step>
    </Steps>

  </Tab>
</Tabs>

## 토큰 모델

- `botToken` + `appToken`은 Socket Mode에 필요합니다.
- HTTP 모드는 `botToken` + `signingSecret`이 필요합니다.
- 설정 토큰은 환경 변수 폴백을 재정의합니다.
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` 환경 변수 폴백은 기본 계정에만 적용됩니다.
- `userToken` (`xoxp-...`)은 설정만 가능합니다 (환경 변수 폴백 없음) 및 기본값은 읽기 전용 동작입니다 (`userTokenReadOnly: true`).
- 선택사항: 나가는 메시지가 활성 에이전트 identity (커스텀 `username` 및 아이콘)를 사용하려면 `chat:write.customize`를 추가합니다. `icon_emoji`는 `:emoji_name:` 구문을 사용합니다.

<Tip>
액션/디렉토리 읽기의 경우 사용자 토큰이 선호될 수 있습니다. 쓰기의 경우 봇 토큰은 선호됩니다; 사용자 토큰 쓰기는 `userTokenReadOnly: false`이고 봇 토큰을 사용할 수 없을 때만 허용됩니다.
</Tip>

## 접근 제어 및 라우팅

<Tabs>
  <Tab title="DM 정책">
    `channels.slack.dmPolicy`는 DM 접근을 제어합니다 (레거시: `channels.slack.dm.policy`):

    - `pairing` (기본값)
    - `allowlist`
    - `open` (requires `channels.slack.allowFrom` to include `"*"`; legacy: `channels.slack.dm.allowFrom`)
    - `disabled`

    DM 플래그:

    - `dm.enabled` (기본값 true)
    - `channels.slack.allowFrom` (선호)
    - `dm.allowFrom` (레거시)
    - `dm.groupEnabled` (그룹 DM 기본값 false)
    - `dm.groupChannels` (선택적 MPIM 허용 목록)

    다중 계정 우선순위:

    - `channels.slack.accounts.default.allowFrom`은 `default` 계정에만 적용됩니다.
    - 명명된 계정은 자신의 `allowFrom`이 설정되지 않을 때 `channels.slack.allowFrom`을 상속합니다.
    - 명명된 계정은 `channels.slack.accounts.default.allowFrom`을 상속하지 않습니다.

    DM의 페어링은 `openclaw pairing approve slack <code>`를 사용합니다.

  </Tab>

  <Tab title="채널 정책">
    `channels.slack.groupPolicy`는 채널 처리를 제어합니다:

    - `open`
    - `allowlist`
    - `disabled`

    채널 허용 목록은 `channels.slack.channels` 아래에 있습니다.

    런타임 참고: `channels.slack`이 완전히 누락되면 (환경만 설정), 런타임은 `groupPolicy="allowlist"`로 폴백합니다 (경고 로그 포함) (`channels.defaults.groupPolicy`가 설정되어 있어도).

    이름/ID 해결:

    - 채널 허용 목록 항목과 DM 허용 목록 항목은 토큰 액세스가 허용할 때 시작할 때 해결됩니다
    - 미해결 항목은 구성된 대로 유지됩니다
    - 인바운드 인증 매칭은 기본적으로 ID 우선입니다; 직접 사용자 이름/슬러그 매칭은 `channels.slack.dangerouslyAllowNameMatching: true`가 필요합니다

  </Tab>

  <Tab title="멘션 및 채널 사용자">
    채널 메시지는 기본적으로 멘션 게이트됩니다.

    멘션 소스:

    - 명시적 앱 멘션 (`<@botId>`)
    - 멘션 regex 패턴 (`agents.list[].groupChat.mentionPatterns`, 폴백 `messages.groupChat.mentionPatterns`)
    - 암시적 봇에 대한 회신 스레드 동작

    채널별 컨트롤 (`channels.slack.channels.<id|name>`):

    - `requireMention`
    - `users` (허용 목록)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`
    - `toolsBySender` 키 형식: `id:`, `e164:`, `username:`, `name:`, 또는 `"*"` 와일드카드
      (레거시 접두사 없는 키는 여전히 `id:`로 매핑됨)

  </Tab>
</Tabs>

## 명령어 및 슬래시 동작

- Slack의 네이티브 명령어 자동 모드는 **꺼져** 있습니다 (`commands.native: "auto"`는 Slack 네이티브 명령어를 활성화하지 않습니다).
- `channels.slack.commands.native: true` (또는 글로벌 `commands.native: true`)로 네이티브 Slack 명령어 핸들러를 활성화합니다.
- 네이티브 명령어가 활성화되면, Slack에서 일치하는 슬래시 명령어를 등록합니다 (`/<command>` 이름), 한 가지 예외:
  - Slack이 `/status`를 예약했으므로 상태 명령어의 경우 `/agentstatus` 등록
- 네이티브 명령어가 활성화되지 않으면, `channels.slack.slashCommand`로 단일 구성된 슬래시 명령어를 실행할 수 있습니다.
- 네이티브 arg 메뉴는 이제 렌더링 전략을 조정합니다:
  - 최대 5개 옵션: 버튼 블록
  - 6-100개 옵션: 정적 선택 메뉴
  - 100개 초과 옵션: 상호작용 옵션 핸들러를 사용할 때 비동기 옵션 필터링이 있는 외부 선택
  - 인코딩된 옵션 값이 Slack 한계를 초과하면 플로우는 버튼으로 폴백합니다
- 긴 옵션 페이로드의 경우, 슬래시 명령어 argument 메뉴는 선택된 값을 디스패치하기 전에 확인 대화를 사용합니다.

기본 슬래시 명령어 설정:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

슬래시 세션은 격리된 키를 사용합니다:

- `agent:<agentId>:slack:slash:<userId>`

그리고 여전히 대상 대화 세션에 대해 명령어 실행을 라우팅합니다 (`CommandTargetSessionKey`).

## 스레딩, 세션, 및 회신 태그

- DM은 `direct`로 라우팅됩니다; 채널은 `channel`; MPIM은 `group`.
- 기본 `session.dmScope=main`으로 Slack DM은 에이전트 메인 세션으로 축소합니다.
- 채널 세션: `agent:<agentId>:slack:channel:<channelId>`.
- 스레드 회신은 해당할 때 스레드 세션 접미사를 만들 수 있습니다 (`:thread:<threadTs>`).
- `channels.slack.thread.historyScope` 기본값은 `thread`; `thread.inheritParent` 기본값은 `false`.
- `channels.slack.thread.initialHistoryLimit`은 새로운 스레드 세션이 시작될 때 몇 개의 기존 스레드 메시지가 가져와지는지 제어합니다 (기본값 `20`; `0`으로 설정하여 비활성화).

회신 스레딩 컨트롤:

- `channels.slack.replyToMode`: `off|first|all` (기본값 `off`)
- `channels.slack.replyToModeByChatType`: per `direct|group|channel`
- 직접 채팅에 대한 레거시 폴백: `channels.slack.dm.replyToMode`

수동 회신 태그가 지원됩니다:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

참고: `replyToMode="off"`는 명시적 `[[reply_to_*]]` 태그를 포함한 Slack의 **모든** 회신 스레딩을 비활성화합니다. 이는 Telegram과 다르며, Telegram은 `"off"` 모드에서도 명시적 태그를 여전히 존중합니다. 차이는 플랫폼 스레딩 모델을 반영합니다: Slack 스레드는 채널에서 메시지를 숨기지만 Telegram 회신은 메인 채팅 흐름에 보이게 유지됩니다.

## 미디어, 청킹, 및 배송

<AccordionGroup>
  <Accordion title="인바운드 첨부">
    Slack 파일 첨부는 Slack 호스팅 비공개 URL에서 다운로드됩니다 (토큰 인증 요청 흐름) 그리고 페치가 성공하고 크기 한계가 허용할 때 미디어 저장소에 작성됩니다.

    런타임 인바운드 크기 상한은 `channels.slack.mediaMaxMb`로 재정의되지 않으면 기본값 `20MB`입니다.

  </Accordion>

  <Accordion title="아웃바운드 텍스트 및 파일">
    - 텍스트 청크는 `channels.slack.textChunkLimit` 사용합니다 (기본값 4000)
    - `channels.slack.chunkMode="newline"`은 단락 우선 분할을 활성화합니다
    - 파일 전송은 Slack 업로드 API를 사용하고 스레드 회신을 포함할 수 있습니다 (`thread_ts`)
    - 아웃바운드 미디어 상한은 구성될 때 `channels.slack.mediaMaxMb`를 따릅니다; 그렇지 않으면 채널 전송은 미디어 파이프라인에서 MIME 종류 기본값을 사용합니다
  </Accordion>

  <Accordion title="배송 대상">
    선호하는 명시적 대상:

    - `user:<id>` for DMs
    - `channel:<id>` for 채널

    Slack DM은 사용자 대상으로 전송할 때 Slack 대화 API를 통해 열립니다.

  </Accordion>
</AccordionGroup>

## 액션 및 게이트

Slack 액션은 `channels.slack.actions.*`로 제어됩니다.

현재 Slack 도구에서 사용 가능한 액션 그룹:

| 그룹       | 기본값  |
| ---------- | ------- |
| messages   | enabled |
| reactions  | enabled |
| pins       | enabled |
| memberInfo | enabled |
| emojiList  | enabled |

## 이벤트 및 운영 동작

- 메시지 편집/삭제/스레드 브로드캐스트는 시스템 이벤트로 매핑됩니다.
- 반응 추가/제거 이벤트는 시스템 이벤트로 매핑됩니다.
- 멤버 참가/떠남, 채널 생성/이름변경, 핀 추가/제거 이벤트는 시스템 이벤트로 매핑됩니다.
- 어시스턴트 스레드 상태 업데이트 (스레드의 "입력 중..." 표시기용)는 `assistant.threads.setStatus`를 사용하고 봇 범위 `assistant:write`를 필요로 합니다.
- `channel_id_changed`는 `configWrites`가 활성화될 때 채널 설정 키를 마이그레이션할 수 있습니다.
- 채널 주제/목적 메타데이터는 신뢰할 수 없는 컨텍스트로 취급되고 라우팅 컨텍스트에 주입될 수 있습니다.
- 블록 액션 및 모달 상호작용은 구조화된 `Slack interaction: ...` 시스템 이벤트를 선택된 값, 레이블, 선택기 값, 및 `workflow_*` 메타데이터를 포함한 풍부한 페이로드 필드로 내보냅니다:
  - 블록 액션: 선택된 값, 레이블, 선택기 값, 및 `workflow_*` 메타데이터
  - 모달 `view_submission` 및 `view_closed` 이벤트 with routed 채널 메타데이터 및 양식 입력

## 응답 반응

`ackReaction`은 OpenClaw이 인바운드 메시지를 처리하는 동안 승인 이모지를 보냅니다.

해결 순서:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- 에이전트 identity 이모지 폴백 (`agents.list[].identity.emoji`, 아니면 "👀")

참고:

- Slack은 shortcodes를 기대합니다 (예: `"eyes"`).
- 채널 또는 계정에 대한 반응을 비활성화하려면 `""`를 사용합니다.

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
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
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
    `channels.slack.userToken`을 구성하면, 일반적인 읽기 범위는:

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
  <Accordion title="채널에서 회신 없음">
    순서대로 확인:

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
    확인:

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy` (또는 레거시 `channels.slack.dm.policy`)
    - 페어링 승인 / 허용 목록 항목

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket 모드가 연결되지 않음">
    봇 + 앱 토큰 및 Slack 앱 설정에서 Socket Mode 활성화를 확인합니다.
  </Accordion>

  <Accordion title="HTTP 모드가 이벤트를 받지 못함">
    다음을 확인합니다:

    - 서명 비밀
    - 웹훅 경로
    - Slack Request URL (Events + Interactivity + Slash Commands)
    - HTTP 계정마다 고유한 `webhookPath`

  </Accordion>

  <Accordion title="네이티브/슬래시 명령어가 실행되지 않음">
    당신이 의도한 것을 확인합니다:

    - 네이티브 명령어 모드 (`channels.slack.commands.native: true`) Slack에 등록된 일치하는 슬래시 명령어 포함
    - 또는 단일 슬래시 명령어 모드 (`channels.slack.slashCommand.enabled: true`)

    또한 `commands.useAccessGroups` 및 채널/사용자 허용 목록을 확인합니다.

  </Accordion>
</AccordionGroup>

## 텍스트 스트리밍

OpenClaw는 Agents and AI Apps API를 통해 Slack 네이티브 텍스트 스트리밍을 지원합니다.

`channels.slack.streaming`은 라이브 미리보기 동작을 제어합니다:

- `off`: 라이브 미리보기 스트리밍 비활성화.
- `partial` (기본값): 미리보기 텍스트를 최신 부분 출력으로 바꿉니다.
- `block`: 청크된 미리보기 업데이트 추가.
- `progress`: 생성하는 동안 진행 상태 텍스트를 표시한 후 최종 텍스트를 보냅니다.

`channels.slack.nativeStreaming`은 `streaming`이 `partial` (기본값: `true`)일 때 Slack의 네이티브 스트리밍 API (`chat.startStream` / `chat.appendStream` / `chat.stopStream`)를 제어합니다.

네이티브 Slack 스트리밍 비활성화 (초안 미리보기 동작 유지):

```yaml
channels:
  slack:
    streaming: partial
    nativeStreaming: false
```

레거시 키:

- `channels.slack.streamMode` (`replace | status_final | append`)은 `channels.slack.streaming`으로 자동 마이그레이션됩니다.
- 부울 `channels.slack.streaming`은 `channels.slack.nativeStreaming`으로 자동 마이그레이션됩니다.

### 요구 사항

1. Slack 앱 설정에서 **Agents and AI Apps** 활성화.
2. 앱에 `assistant:write` 범위가 있는지 확인.
3. 해당 메시지에 대해 회신 스레드를 사용할 수 있어야 합니다. 스레드 선택은 여전히 `replyToMode`를 따릅니다.

### 동작

- 첫 번째 텍스트 청크는 스트림을 시작합니다 (`chat.startStream`).
- 이후 텍스트 청크는 동일 스트림에 추가합니다 (`chat.appendStream`).
- 회신 끝은 스트림을 완료합니다 (`chat.stopStream`).
- 미디어 및 텍스트가 아닌 페이로드는 정상 배송으로 폴백합니다.
- 스트리밍이 회신 중 실패하면 OpenClaw는 나머지 페이로드에 대해 정상 배송으로 폴백합니다.

## 설정 참조 포인터

기본 참조:

- [설정 참조 - Slack](/gateway/configuration-reference#slack)

높은 신호 Slack 필드:

- 모드/인증: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
- DM 접근: `dm.enabled`, `dmPolicy`, `allowFrom` (레거시: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
- 호환성 토글: `dangerouslyAllowNameMatching` (break-glass; 필요하지 않으면 꺼짐)
- 채널 접근: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
- 스레딩/이력: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- 배송: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `streaming`, `nativeStreaming`
- ops/기능: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## 관련

- [페어링](/channels/pairing)
- [채널 라우팅](/channels/channel-routing)
- [문제 해결](/channels/troubleshooting)
- [설정](/gateway/configuration)
- [슬래시 명령어](/tools/slash-commands)
