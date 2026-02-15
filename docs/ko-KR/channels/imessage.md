---
summary: "Legacy iMessage support via imsg (JSON-RPC over stdio). New setups should use BlueBubbles."
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
title: "iMessage"
x-i18n:
  source_hash: 8586ebd265580718272ebb800bb97611fa7a28a0a7cade615489a6d1371c7ad9
---

# iMessage(레거시: imsg)

<Warning>
새로운 iMessage 배포의 경우 <a href="/channels/bluebubbles">BlueBubbles</a>를 사용하세요.

`imsg` 통합은 레거시이며 향후 릴리스에서 제거될 수 있습니다.
</Warning>

상태: 레거시 외부 CLI 통합. 게이트웨이는 `imsg rpc`를 생성하고 stdio에서 JSON-RPC를 통해 통신합니다(별도의 데몬/포트 없음).

<CardGroup cols={3}>
  <Card title="BlueBubbles (recommended)" icon="message-circle" href="/channels/bluebubbles">
    새로운 설정을 위한 기본 iMessage 경로입니다.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    iMessage DM은 기본적으로 페어링 모드로 설정됩니다.
  </Card>
  <Card title="Configuration reference" icon="settings" href="/gateway/configuration-reference#imessage">
    전체 iMessage 필드 참조.
  </Card>
</CardGroup>

## 빠른 설정

<Tabs>
  <Tab title="Local Mac (fast path)">
    <Steps>
      <Step title="Install and verify imsg">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>

      <Step title="Approve first DM pairing (default dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        페어링 요청은 1시간 후에 만료됩니다.
      </Step>
    </Steps>

  </Tab>

  <Tab title="Remote Mac over SSH">
    OpenClaw에는 stdio 호환 `cliPath`만 필요하므로 원격 Mac에 SSH로 연결하고 `imsg`를 실행하는 래퍼 스크립트에서 `cliPath`를 지정할 수 있습니다.

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

    첨부 파일이 활성화된 경우 권장 구성:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // used for SCP attachment fetches
      includeAttachments: true,
    },
  },
}
```

    `remoteHost`가 설정되지 않은 경우 OpenClaw는 SSH 래퍼 스크립트를 구문 분석하여 자동 감지를 시도합니다.

  </Tab>
</Tabs>

## 요구 사항 및 권한(macOS)

- 메시지는 `imsg`를 실행하는 Mac에서 로그인해야 합니다.
- OpenClaw/`imsg`(메시지 DB 액세스)를 실행하는 프로세스 컨텍스트에는 전체 디스크 액세스가 필요합니다.
- Messages.app을 통해 메시지를 보내려면 자동화 권한이 필요합니다.

<Tip>
프로세스 컨텍스트별로 권한이 부여됩니다. 게이트웨이가 헤드리스(LaunchAgent/SSH)를 실행하는 경우 동일한 컨텍스트에서 일회성 대화형 명령을 실행하여 프롬프트를 트리거합니다.

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

</Tip>

## 액세스 제어 및 라우팅

<Tabs>
  <Tab title="DM policy">
    `channels.imessage.dmPolicy`는 직접 메시지를 제어합니다.

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`"*"`를 포함하려면 `allowFrom` 필요)
    - `disabled`

    허용 목록 필드: `channels.imessage.allowFrom`.

    허용 목록 항목은 핸들 또는 채팅 대상(`chat_id:*`, `chat_guid:*`, `chat_identifier:*`)일 수 있습니다.

  </Tab>

  <Tab title="Group policy + mentions">
    `channels.imessage.groupPolicy`는 그룹 처리를 제어합니다.

    - `allowlist` (구성 시 기본값)
    - `open`
    - `disabled`

    그룹 발신자 허용 목록: `channels.imessage.groupAllowFrom`.

    런타임 대체: `groupAllowFrom`가 설정되지 않은 경우 iMessage 그룹 발신자는 사용 가능한 경우 `allowFrom`로 대체됩니다.

    그룹에 대한 게이팅 언급:

    - iMessage에는 기본 멘션 메타데이터가 없습니다.
    - 멘션 감지는 정규식 패턴(`agents.list[].groupChat.mentionPatterns`, 대체 `messages.groupChat.mentionPatterns`)을 사용합니다.
    - 구성된 패턴이 없으면 멘션 게이팅을 시행할 수 없습니다.

    승인된 발신자의 제어 명령은 그룹 내 멘션 게이팅을 우회할 수 있습니다.

  </Tab>

<Tab title="Sessions and deterministic replies">
    - DM은 직접 라우팅을 사용합니다. 그룹은 그룹 라우팅을 사용합니다.
    - 기본적으로 `session.dmScope=main`, iMessage DM은 에이전트 기본 세션으로 축소됩니다.
    - 그룹 세션은 격리됩니다(`agent:<agentId>:imessage:group:<chat_id>`).
    - 원래 채널/대상 메타데이터를 사용하여 iMessage로 다시 라우팅합니다.

    그룹 같은 스레드 동작:

    일부 다중 참가자 iMessage 스레드는 `is_group=false`와 함께 도착할 수 있습니다.
    해당 `chat_id`가 `channels.imessage.groups` 아래에 명시적으로 구성된 경우 OpenClaw는 이를 그룹 트래픽(그룹 게이팅 + 그룹 세션 격리)으로 처리합니다.

  </Tab>
</Tabs>

## 배포 패턴

<AccordionGroup>
  <Accordion title="Dedicated bot macOS user (separate iMessage identity)">
    전용 Apple ID 및 macOS 사용자를 사용하면 봇 트래픽이 개인 메시지 프로필에서 격리됩니다.

    일반적인 흐름:

    1. 전용 macOS 사용자를 생성/로그인합니다.
    2. 해당 사용자의 봇 Apple ID로 메시지에 로그인합니다.
    3. 해당 사용자에게 `imsg`를 설치합니다.
    4. OpenClaw가 해당 사용자 컨텍스트에서 `imsg`를 실행할 수 있도록 SSH 래퍼를 생성합니다.
    5. `channels.imessage.accounts.<id>.cliPath` 및 `.dbPath`를 해당 사용자 프로필에 지정합니다.

    처음 실행하려면 해당 봇 사용자 세션에서 GUI 승인(자동화 + 전체 디스크 액세스)이 필요할 수 있습니다.

  </Accordion>

  <Accordion title="Remote Mac over Tailscale (example)">
    일반적인 토폴로지:

    - 게이트웨이는 Linux/VM에서 실행됩니다.
    - iMessage + `imsg`는 tailnet의 Mac에서 실행됩니다.
    - `cliPath` 래퍼는 SSH를 사용하여 `imsg`를 실행합니다.
    - `remoteHost` SCP 첨부 파일 가져오기를 활성화합니다.

    예:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

    SSH 키를 사용하면 SSH와 SCP가 모두 비대화형이 됩니다.

  </Accordion>

  <Accordion title="Multi-account pattern">
    iMessage는 `channels.imessage.accounts`에서 계정별 구성을 지원합니다.

    각 계정은 `cliPath`, `dbPath`, `allowFrom`, `groupPolicy`, `mediaMaxMb`와 같은 필드 및 기록 설정을 재정의할 수 있습니다.

  </Accordion>
</AccordionGroup>

## 미디어, 청크, 전달 대상

<AccordionGroup>
  <Accordion title="Attachments and media">
    - 인바운드 첨부 파일 수집은 선택 사항입니다. `channels.imessage.includeAttachments`
    - `remoteHost`가 설정된 경우 SCP를 통해 원격 연결 경로를 가져올 수 있습니다.
    - 아웃바운드 미디어 크기는 `channels.imessage.mediaMaxMb`를 사용합니다(기본값 16MB).
  </Accordion>

  <Accordion title="Outbound chunking">
    - 텍스트 청크 제한: `channels.imessage.textChunkLimit` (기본값 4000)
    - 청크 모드: `channels.imessage.chunkMode`
      - `length` (기본값)
      - `newline` (단락 우선 분할)
  </Accordion>

  <Accordion title="Addressing formats">
    선호하는 명시적 대상:

    - `chat_id:123` (안정적인 라우팅을 위해 권장)
    - `chat_guid:...`
    - `chat_identifier:...`

    핸들 타겟도 지원됩니다:

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

```bash
imsg chats --limit 20
```

  </Accordion>
</AccordionGroup>

## 구성 쓰기

iMessage는 기본적으로 채널 시작 구성 쓰기를 허용합니다(`commands.config: true`인 경우 `/config set|unset`에 대해).

비활성화:

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## 문제 해결

<AccordionGroup>
  <Accordion title="imsg not found or RPC unsupported">
    바이너리 및 RPC 지원을 확인합니다.

```bash
imsg rpc --help
openclaw channels status --probe
```

    프로브가 RPC가 지원되지 않는다고 보고하면 `imsg`를 업데이트하세요.

  </Accordion>

  <Accordion title="DMs are ignored">
    확인:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - 페어링 승인 (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="Group messages are ignored">
    확인:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` 허용 목록 동작
    - 언급 패턴 구성 (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="Remote attachments fail">
    확인:

    - `channels.imessage.remoteHost`
    - 게이트웨이 호스트의 SSH/SCP 키 인증
    - 메시지를 실행하는 Mac에서의 원격 경로 가독성

  </Accordion>

  <Accordion title="macOS permission prompts were missed">
    동일한 사용자/세션 컨텍스트의 대화형 GUI 터미널에서 다시 실행하고 프롬프트를 승인합니다.

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    OpenClaw/`imsg`를 실행하는 프로세스 컨텍스트에 대해 전체 디스크 액세스 + 자동화가 부여되었는지 확인하세요.

  </Accordion>
</AccordionGroup>

## 구성 참조 포인터

- [구성 참조 - iMessage](/gateway/configuration-reference#imessage)
- [게이트웨이 구성](/gateway/configuration)
- [페어링](/channels/pairing)
- [블루버블](/channels/bluebubbles)
