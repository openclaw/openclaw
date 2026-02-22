---
summary: "Legacy iMessage 지원 (stdio 를 통해 JSON-RPC 를 사용하는 imsg). 신규 설정은 BlueBubbles 를 사용해야 합니다."
read_when:
  - iMessage 지원 설정
  - iMessage 발신/수신 문제 해결
title: "iMessage"
---

# iMessage (legacy: imsg)

<Warning>
신규 iMessage 배포에는 <a href="/ko-KR/channels/bluebubbles">BlueBubbles</a>를 사용하세요.

`imsg` 통합은 구식이며, 향후 릴리스에서 제거될 수 있습니다.
</Warning>

상태: 전통적인 외부 CLI 통합. 게이트웨이는 `imsg rpc`를 스폰하며 stdio 상에서 JSON-RPC 를 통해 통신합니다 (별도의 데몬/포트 없음).

<CardGroup cols={3}>
  <Card title="BlueBubbles (추천)" icon="message-circle" href="/ko-KR/channels/bluebubbles">
    신규 설정에 추천되는 iMessage 경로.
  </Card>
  <Card title="페어링" icon="link" href="/ko-KR/channels/pairing">
    iMessage 다이렉트 메시지는 디폴트로 페어링 모드를 사용합니다.
  </Card>
  <Card title="설정 참조" icon="settings" href="/ko-KR/gateway/configuration-reference#imessage">
    전체 iMessage 필드 참조.
  </Card>
</CardGroup>

## 빠른 설정

<Tabs>
  <Tab title="로컬 Mac (빠른 경로)">
    <Steps>
      <Step title="imsg 설치 및 검증">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="OpenClaw 설정">

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

      <Step title="게이트웨이 시작">

```bash
openclaw gateway
```

      </Step>

      <Step title="첫 번째 다이렉트 메시지 페어링 승인 (기본 dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        페어링 요청은 1시간 후에 만료됩니다.
      </Step>
    </Steps>

  </Tab>

  <Tab title="SSH를 통한 원격 Mac">
    OpenClaw는 stdio 호환 `cliPath`만 필요하므로, `cliPath`를 원격 Mac 에 SSH를 통해 `imsg`를 실행하는 래퍼 스크립트로 지정할 수 있습니다.

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

    첨부 파일이 활성화된 경우 추천 구성:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // SCP 첨부 파일 가져오기에 사용
      includeAttachments: true,
      // 선택: 허용된 첨부 파일 루트 재정의.
      // 기본값에는 /Users/*/Library/Messages/Attachments가 포함됩니다
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    `remoteHost`가 설정되지 않은 경우, OpenClaw는 SSH 래퍼 스크립트를 파싱하여 자동으로 감지하려고 시도합니다.
    `remoteHost`는 `host` 또는 `user@host` 형식이어야 합니다 (공백이나 SSH 옵션 불가).
    OpenClaw는 SCP에 엄격한 호스트 키 검사를 사용하므로, 릴레이 호스트 키가 이미 `~/.ssh/known_hosts`에 있어야 합니다.
    첨부 파일 경로는 허용된 루트(`attachmentRoots` / `remoteAttachmentRoots`)에 대해 검증됩니다.

  </Tab>
</Tabs>

## 요구 사항 및 권한 (macOS)

- `imsg`를 실행하는 Mac에서 Messages에 로그인되어 있어야 합니다.
- OpenClaw/`imsg`를 실행 중인 프로세스 컨텍스트에는 전체 디스크 접근 권한이 필요합니다 (Messages DB에 접근).
- Messages.app을 통해 메시지를 보내기 위해 자동화 권한이 필요합니다.

<Tip>
권한은 프로세스 컨텍스트별로 부여됩니다. 게이트웨이가 헤드리스(LaunchAgent/SSH) 상태로 실행 중인 경우, 동일한 컨텍스트에서 대화형 명령을 한 번 실행하여 프롬프트를 트리거하세요:

```bash
imsg chats --limit 1
# 또는
imsg send <handle> "test"
```

</Tip>

## 접근 제어 및 라우팅

<Tabs>
  <Tab title="DM 정책">
    `channels.imessage.dmPolicy`는 다이렉트 메시지를 제어합니다:

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`allowFrom`에 `"*"`을 포함해야 함)
    - `disabled`

    알로우 리스트 필드: `channels.imessage.allowFrom`.

    알로우 리스트 항목은 핸들 또는 채팅 대상(`chat_id:*`, `chat_guid:*`, `chat_identifier:*`) 일 수 있습니다.

  </Tab>

  <Tab title="그룹 정책 + 멘션">
    `channels.imessage.groupPolicy`는 그룹 처리 방식을 제어합니다:

    - `allowlist` (구성된 경우 기본값)
    - `open`
    - `disabled`

    그룹 발신자 알로우 리스트: `channels.imessage.groupAllowFrom`.

    런타임 폴백: `groupAllowFrom`이 설정되지 않은 경우, iMessage 그룹 발신자 체크는 사용 가능한 경우 `allowFrom`으로 폴백합니다.

    그룹 멘션 게이팅:

    - iMessage는 네이티브 멘션 메타데이터가 없습니다
    - 멘션 감지는 정규식 패턴을 사용합니다 (`agents.list[].groupChat.mentionPatterns`, 폴백 `messages.groupChat.mentionPatterns`)
    - 패턴이 구성되지 않은 경우, 멘션 게이팅이 적용되지 않습니다

    인증된 발신자의 제어 명령은 그룹에서 멘션 게이팅을 우회할 수 있습니다.

  </Tab>

  <Tab title="세션 및 결정적 응답">
    - 다이렉트 메시지는 직접 라우팅을 사용하고, 그룹은 그룹 라우팅을 사용합니다.
    - 기본 `session.dmScope=main`으로, iMessage 다이렉트 메시지는 에이전트의 메인 세션으로 병합됩니다.
    - 그룹 세션은 격리되어 있습니다 (`agent:<agentId>:imessage:group:<chat_id>`).
    - 응답은 시작 채널/대상 메타데이터를 사용하여 iMessage로 다시 라우팅됩니다.

    그룹 유사 스레드 행동:

    일부 다수 참여자 iMessage 스레드는 `is_group=false`로 도착할 수 있습니다.
    해당 `chat_id`가 `channels.imessage.groups`에 명시적으로 구성된 경우, OpenClaw는 이를 그룹 트래픽(그룹 게이팅 + 그룹 세션 격리)으로 처리합니다.

  </Tab>
</Tabs>

## 배포 패턴

<AccordionGroup>
  <Accordion title="전용 봇 macOS 사용자 (분리된 iMessage 계정)">
    봇 트래픽을 개인 메시지 프로필과 분리하기 위해 전용 Apple ID 및 macOS 사용자를 사용합니다.

    일반적인 흐름:

    1. 전용 macOS 사용자 생성/로그인.
    2. 해당 사용자에서 봇 Apple ID로 Messages 로그인.
    3. 해당 사용자에서 `imsg` 설치.
    4. OpenClaw가 해당 사용자 컨텍스트에서 `imsg`를 실행할 수 있도록 SSH 래퍼 생성.
    5. `channels.imessage.accounts.<id>.cliPath` 및 `.dbPath`를 해당 사용자 프로필로 가리킵니다.

    최초 실행 시 그 봇 사용자 세션에서 GUI 승인이 필요할 수 있습니다.

  </Accordion>

  <Accordion title="Tailscale 을 통한 원격 Mac (예제)">
    일반적인 토폴로지:

    - 게이트웨이는 Linux/VM에서 실행
    - iMessage + `imsg`는 tailnet에 있는 Mac 에서 실행
    - `cliPath` 래퍼는 SSH를 통해 `imsg`를 실행
    - `remoteHost`는 SCP 첨부 파일 가져오기를 활성화

    예제:

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

    SSH 키를 사용하여 SSH 및 SCP가 비대화형으로 작동하도록 합니다.
    먼저 호스트 키를 신뢰하세요 (예: `ssh bot@mac-mini.tailnet-1234.ts.net`) so `known_hosts`가 채워집니다.

  </Accordion>

  <Accordion title="멀티 계정 패턴">
    iMessage는 `channels.imessage.accounts` 하에 계정별 구성을 지원합니다.

    각 계정은 `cliPath`, `dbPath`, `allowFrom`, `groupPolicy`, `mediaMaxMb`, 히스토리 설정, 및 첨부 파일 루트 허용 목록과 같은 필드를 변경할 수 있습니다.

  </Accordion>
</AccordionGroup>

## 미디어, 청킹, 및 전송 대상

<AccordionGroup>
  <Accordion title="첨부 파일 및 미디어">
    - 인바운드 첨부 파일 수집은 선택 사항: `channels.imessage.includeAttachments`
    - 원격 첨부 경로는 `remoteHost`가 설정된 경우 SCP를 통해 가져올 수 있음
    - 첨부 파일 경로는 허용된 루트와 일치해야 합니다:
      - `channels.imessage.attachmentRoots` (로컬)
      - `channels.imessage.remoteAttachmentRoots` (원격 SCP 모드)
      - 기본 루트 패턴: `/Users/*/Library/Messages/Attachments`
    - SCP는 엄격한 호스트 키 검사 사용 (`StrictHostKeyChecking=yes`)
    - 아웃바운드 미디어 크기는 `channels.imessage.mediaMaxMb` 사용 (기본값 16MB)
  </Accordion>

  <Accordion title="아웃바운드 청킹">
    - 텍스트 청크 제한: `channels.imessage.textChunkLimit` (기본값 4,000)
    - 청크 모드: `channels.imessage.chunkMode`
      - `length` (기본값)
      - `newline` (단락 우선 분할)
  </Accordion>

  <Accordion title="주소 지정 형식">
    선호되는 명시적 대상:

    - `chat_id:123` (안정적인 라우팅에 권장)
    - `chat_guid:...`
    - `chat_identifier:...`

    핸들 대상도 지원됨:

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

```bash
imsg chats --limit 20
```

  </Accordion>
</AccordionGroup>

## 설정 쓰기

iMessage 는 기본적으로 채널에서 시작된 `/config set|unset`에 의한 설정 업데이트 작성을 허용합니다 (`commands.config: true` 필요).

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
  <Accordion title="imsg 를 찾을 수 없음 또는 RPC 지원되지 않음">
    바이너리 및 RPC 지원을 확인하세요:

```bash
imsg rpc --help
openclaw channels status --probe
```

    프로브가 RPC가 지원되지 않는다고 보고하면, `imsg`를 업데이트 하세요.

  </Accordion>

  <Accordion title="다이렉트 메시지가 무시됨">
    확인하세요:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - 페어링 승인 (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="그룹 메시지가 무시됨">
    확인하세요:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` 알로우 리스트 동작
    - 멘션 패턴 구성 (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="원격 첨부가 실패함">
    확인하세요:

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - 게이트웨이 호스트로부터 SSH/SCP 키 인증
    - 게이트웨이 호스트의 `~/.ssh/known_hosts`에 호스트 키 존재 여부
    - Messages 를 실행 중인 Mac에서 원격 경로의 가독성

  </Accordion>

  <Accordion title="macOS 권한 프롬프트를 놓침">
    동일한 사용자/세션 컨텍스트에서 대화형 GUI 터미널을 다시 실행하고 프롬프트를 승인하세요:

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    OpenClaw/`imsg`를 실행하는 프로세스 컨텍스트에 전체 디스크 접근 + 자동화가 부여 되었는지 확인하세요.

  </Accordion>
</AccordionGroup>

## 설정 참조 포인터

- [설정 참조 - iMessage](/ko-KR/gateway/configuration-reference#imessage)
- [게이트웨이 설정](/ko-KR/gateway/configuration)
- [페어링](/ko-KR/channels/pairing)
- [BlueBubbles](/ko-KR/channels/bluebubbles)
