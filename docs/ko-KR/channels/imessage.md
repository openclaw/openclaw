---
summary: "imsg 를 통한 레거시 iMessage 지원 (stdio 를 통한 JSON-RPC). 새 설정에는 BlueBubbles 를 사용하세요."
read_when:
  - iMessage 지원을 설정하는 경우
  - iMessage 송수신을 디버깅하는 경우
title: "iMessage"
x-i18n:
  source_path: docs/channels/imessage.md
---

# iMessage (레거시: imsg)

<Warning>
새로운 iMessage 배포에는 <a href="/channels/bluebubbles">BlueBubbles</a> 를 사용하세요.

`imsg` 통합은 레거시이며 향후 릴리스에서 제거될 수 있습니다.
</Warning>

상태: 레거시 외부 CLI 통합. Gateway 는 `imsg rpc` 를 생성하고 stdio 를 통한 JSON-RPC 로 통신합니다 (별도의 데몬/포트 없음).

<CardGroup cols={3}>
  <Card title="BlueBubbles (권장)" icon="message-circle" href="/channels/bluebubbles">
    새 설정을 위한 권장 iMessage 경로.
  </Card>
  <Card title="페어링" icon="link" href="/channels/pairing">
    iMessage DM 은 기본적으로 페어링 모드입니다.
  </Card>
  <Card title="구성 참조" icon="settings" href="/gateway/configuration-reference#imessage">
    전체 iMessage 필드 참조.
  </Card>
</CardGroup>

## 빠른 설정

<Tabs>
  <Tab title="로컬 Mac (빠른 경로)">
    <Steps>
      <Step title="imsg 설치 및 확인">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="OpenClaw 구성">

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

      <Step title="Gateway 시작">

```bash
openclaw gateway
```

      </Step>

      <Step title="첫 DM 페어링 승인 (기본 dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        페어링 요청은 1 시간 후 만료됩니다.
      </Step>
    </Steps>

  </Tab>

  <Tab title="SSH 를 통한 원격 Mac">
    OpenClaw 는 stdio 호환 `cliPath` 만 필요하므로, `cliPath` 를 원격 Mac 에 SSH 접속하여 `imsg` 를 실행하는 래퍼 스크립트에 지정할 수 있습니다.

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
      remoteHost: "user@gateway-host", // SCP 첨부 파일 가져오기에 사용
      includeAttachments: true,
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    `remoteHost` 가 설정되지 않으면 OpenClaw 는 SSH 래퍼 스크립트를 파싱하여 자동 감지를 시도합니다.

  </Tab>
</Tabs>

## 요구 사항 및 권한 (macOS)

- `imsg` 를 실행하는 Mac 에서 Messages 에 로그인되어 있어야 합니다.
- OpenClaw/`imsg` 를 실행하는 프로세스 컨텍스트에 전체 디스크 접근 권한이 필요합니다.
- Messages.app 을 통해 메시지를 보내려면 자동화 권한이 필요합니다.

<Tip>
권한은 프로세스 컨텍스트별로 부여됩니다. Gateway 가 헤드리스 (LaunchAgent/SSH) 로 실행되는 경우, 해당 컨텍스트에서 일회성 대화형 명령을 실행하여 프롬프트를 트리거합니다:

```bash
imsg chats --limit 1
# 또는
imsg send <handle> "test"
```

</Tip>

## 접근 제어 및 라우팅

<Tabs>
  <Tab title="DM 정책">
    `channels.imessage.dmPolicy` 는 다이렉트 메시지를 제어합니다:

    - `pairing` (기본값)
    - `allowlist`
    - `open` (`allowFrom` 에 `"*"` 포함 필요)
    - `disabled`

    허용 목록 필드: `channels.imessage.allowFrom`.

    허용 목록 항목은 핸들 또는 채팅 대상 (`chat_id:*`, `chat_guid:*`, `chat_identifier:*`) 일 수 있습니다.

  </Tab>

  <Tab title="그룹 정책 + 멘션">
    `channels.imessage.groupPolicy` 는 그룹 처리를 제어합니다:

    - `allowlist` (구성된 경우 기본값)
    - `open`
    - `disabled`

    그룹 발신자 허용 목록: `channels.imessage.groupAllowFrom`.

    런타임 폴백: `groupAllowFrom` 이 미설정이면, iMessage 그룹 발신자 검사는 사용 가능한 경우 `allowFrom` 으로 폴백합니다.

    그룹의 멘션 게이팅:

    - iMessage 에는 네이티브 멘션 메타데이터가 없습니다
    - 멘션 감지는 정규식 패턴을 사용합니다 (`agents.list[].groupChat.mentionPatterns`, 폴백 `messages.groupChat.mentionPatterns`)
    - 구성된 패턴이 없으면 멘션 게이팅을 적용할 수 없습니다

    권한이 부여된 발신자의 제어 명령은 그룹에서 멘션 게이팅을 우회할 수 있습니다.

  </Tab>

  <Tab title="세션 및 결정적 응답">
    - DM 은 직접 라우팅을 사용합니다. 그룹은 그룹 라우팅을 사용합니다.
    - 기본 `session.dmScope=main` 에서, iMessage DM 은 에이전트 메인 세션으로 축소됩니다.
    - 그룹 세션은 격리됩니다 (`agent:<agentId>:imessage:group:<chat_id>`).
    - 응답은 원본 채널/대상 메타데이터를 사용하여 iMessage 로 다시 라우팅됩니다.

  </Tab>
</Tabs>

## 배포 패턴

<AccordionGroup>
  <Accordion title="전용 봇 macOS 사용자 (별도 iMessage ID)">
    봇 트래픽이 개인 Messages 프로필에서 격리되도록 전용 Apple ID 와 macOS 사용자를 사용합니다.
  </Accordion>

  <Accordion title="Tailscale 를 통한 원격 Mac (예시)">
    일반적인 토폴로지:

    - Gateway 는 Linux/VM 에서 실행
    - iMessage + `imsg` 는 tailnet 의 Mac 에서 실행
    - `cliPath` 래퍼가 SSH 를 사용하여 `imsg` 실행
    - `remoteHost` 가 SCP 첨부 파일 가져오기를 활성화

  </Accordion>

  <Accordion title="다중 계정 패턴">
    iMessage 는 `channels.imessage.accounts` 하위에서 계정별 구성을 지원합니다.
  </Accordion>
</AccordionGroup>

## 미디어, 청킹, 전달 대상

<AccordionGroup>
  <Accordion title="첨부 파일 및 미디어">
    - 인바운드 첨부 파일 수집은 선택 사항: `channels.imessage.includeAttachments`
    - `remoteHost` 가 설정된 경우 원격 첨부 파일 경로를 SCP 로 가져올 수 있음
    - 아웃바운드 미디어 크기: `channels.imessage.mediaMaxMb` (기본값 16 MB)
  </Accordion>

  <Accordion title="아웃바운드 청킹">
    - 텍스트 청크 제한: `channels.imessage.textChunkLimit` (기본값 4000)
    - 청크 모드: `channels.imessage.chunkMode`
      - `length` (기본값)
      - `newline` (단락 우선 분할)
  </Accordion>

  <Accordion title="주소 지정 형식">
    권장 명시적 대상:

    - `chat_id:123` (안정적 라우팅에 권장)
    - `chat_guid:...`
    - `chat_identifier:...`

    핸들 대상도 지원됩니다:

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

  </Accordion>
</AccordionGroup>

## 구성 쓰기

iMessage 는 기본적으로 채널 시작 구성 쓰기를 허용합니다 (`commands.config: true` 일 때 `/config set|unset` 용).

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
  <Accordion title="imsg 를 찾을 수 없거나 RPC 미지원">
    바이너리와 RPC 지원을 검증합니다:

```bash
imsg rpc --help
openclaw channels status --probe
```

    프로브가 RPC 미지원을 보고하면 `imsg` 를 업데이트합니다.

  </Accordion>

  <Accordion title="DM 이 무시됨">
    확인:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - 페어링 승인 (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="그룹 메시지가 무시됨">
    확인:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` 허용 목록 동작
    - 멘션 패턴 구성 (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="원격 첨부 파일 실패">
    확인:

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - Gateway 호스트에서 SSH/SCP 키 인증
    - Gateway 호스트의 `~/.ssh/known_hosts` 에 호스트 키 존재

  </Accordion>

  <Accordion title="macOS 권한 프롬프트를 놓침">
    동일한 사용자/세션 컨텍스트의 대화형 GUI 터미널에서 다시 실행하고 프롬프트를 승인합니다:

```bash
imsg chats --limit 1
imsg send <handle> "test"
```

    OpenClaw/`imsg` 를 실행하는 프로세스 컨텍스트에 전체 디스크 접근 + 자동화가 부여되었는지 확인합니다.

  </Accordion>
</AccordionGroup>

## 구성 참조 포인터

- [Configuration reference - iMessage](/gateway/configuration-reference#imessage)
- [Gateway configuration](/gateway/configuration)
- [Pairing](/channels/pairing)
- [BlueBubbles](/channels/bluebubbles)
