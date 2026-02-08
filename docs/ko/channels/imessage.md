---
summary: "imsg를 통한 레거시 iMessage 지원 (stdio 상의 JSON-RPC). 새로운 설정에서는 BlueBubbles 사용을 권장합니다."
read_when:
  - iMessage 지원 설정
  - iMessage 송수신 디버깅
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:16Z
---

# iMessage (레거시: imsg)

> **권장:** 새로운 iMessage 설정에는 [BlueBubbles](/channels/bluebubbles)를 사용하십시오.
>
> `imsg` 채널은 레거시 외부 CLI 통합이며, 향후 릴리스에서 제거될 수 있습니다.

상태: 레거시 외부 CLI 통합. Gateway(게이트웨이)는 `imsg rpc` (stdio 상의 JSON-RPC)를 스폰합니다.

## 빠른 설정 (초보자)

1. 이 Mac 에서 Messages 에 로그인되어 있는지 확인합니다.
2. `imsg` 설치:
   - `brew install steipete/tap/imsg`
3. `channels.imessage.cliPath` 및 `channels.imessage.dbPath` 로 OpenClaw 를 구성합니다.
4. Gateway(게이트웨이)를 시작하고 macOS 프롬프트(자동화 + 전체 디스크 접근)를 승인합니다.

최소 설정:

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

## 개요

- macOS 에서 `imsg` 로 구동되는 iMessage 채널입니다.
- 결정적 라우팅: 답장은 항상 iMessage 로 돌아갑니다.
- 다이렉트 메시지는 에이전트의 메인 세션을 공유하며, 그룹은 분리됩니다(`agent:<agentId>:imessage:group:<chat_id>`).
- 여러 참여자가 있는 스레드가 `is_group=false` 와 함께 도착하더라도, `channels.imessage.groups` 를 사용하여 `chat_id` 으로 여전히 분리할 수 있습니다(아래 '그룹 유사 스레드' 참고).

## 설정 쓰기

기본적으로 iMessage 는 `/config set|unset` 에 의해 트리거되는 설정 업데이트 쓰기를 허용합니다(`commands.config: true` 필요).

비활성화하려면:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## 요구 사항

- Messages 에 로그인된 macOS.
- OpenClaw + `imsg` 에 대한 전체 디스크 접근 권한(Messages DB 접근).
- 전송 시 자동화 권한.
- `channels.imessage.cliPath` 는 stdin/stdout 을 프록시하는 어떤 명령이든 가리킬 수 있습니다(예: 다른 Mac 으로 SSH 한 뒤 `imsg rpc` 를 실행하는 래퍼 스크립트).

## macOS 개인정보 보호 및 보안 TCC 문제 해결

송수신이 실패하는 경우(예: `imsg rpc` 가 비정상 종료, 타임아웃, 또는 Gateway(게이트웨이)가 멈춘 것처럼 보이는 경우), 승인되지 않은 macOS 권한 프롬프트가 일반적인 원인입니다.

macOS 는 앱/프로세스 컨텍스트별로 TCC 권한을 부여합니다. `imsg` 를 실행하는 동일한 컨텍스트(예: Terminal/iTerm, LaunchAgent 세션, 또는 SSH 로 실행된 프로세스)에서 프롬프트를 승인하십시오.

체크리스트:

- **전체 디스크 접근**: OpenClaw 를 실행하는 프로세스(및 `imsg` 를 실행하는 모든 셸/SSH 래퍼)에 대한 접근을 허용합니다. 이는 Messages 데이터베이스(`chat.db`)를 읽기 위해 필요합니다.
- **자동화 → Messages**: 아웃바운드 전송을 위해 OpenClaw 를 실행하는 프로세스(및/또는 터미널)가 **Messages.app** 을 제어하도록 허용합니다.
- **`imsg` CLI 상태**: `imsg` 가 설치되어 있고 RPC(`imsg rpc --help`)를 지원하는지 확인합니다.

팁: OpenClaw 가 헤드리스(LaunchAgent/systemd/SSH)로 실행 중이면 macOS 프롬프트를 놓치기 쉽습니다. GUI 터미널에서 한 번의 인터랙티브 명령을 실행하여 프롬프트를 강제로 띄운 후 다시 시도하십시오:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

관련 macOS 폴더 권한(데스크탑/문서/다운로드): [/platforms/mac/permissions](/platforms/mac/permissions).

## 설정 (빠른 경로)

1. 이 Mac 에서 Messages 에 로그인되어 있는지 확인합니다.
2. iMessage 를 구성하고 Gateway(게이트웨이)를 시작합니다.

### 전용 봇 macOS 사용자 (격리된 아이덴티티)

봇이 **별도의 iMessage 아이덴티티**로 전송하도록 하여 개인 Messages 를 깔끔하게 유지하려면, 전용 Apple ID 와 전용 macOS 사용자를 사용하십시오.

1. 전용 Apple ID 생성(예: `my-cool-bot@icloud.com`).
   - Apple 은 검증/2FA 를 위해 전화번호를 요구할 수 있습니다.
2. macOS 사용자 생성(예: `openclawhome`) 후 로그인합니다.
3. 해당 macOS 사용자에서 Messages 를 열고 봇 Apple ID 로 iMessage 에 로그인합니다.
4. 원격 로그인 활성화(시스템 설정 → 일반 → 공유 → 원격 로그인).
5. `imsg` 설치:
   - `brew install steipete/tap/imsg`
6. `ssh <bot-macos-user>@localhost true` 가 비밀번호 없이 동작하도록 SSH 를 설정합니다.
7. `channels.imessage.accounts.bot.cliPath` 을 봇 사용자로 `imsg` 를 실행하는 SSH 래퍼로 지정합니다.

첫 실행 참고: 송수신에는 *봇 macOS 사용자*에서 GUI 승인(자동화 + 전체 디스크 접근)이 필요할 수 있습니다. `imsg rpc` 가 멈춘 것처럼 보이거나 종료되면, 해당 사용자로 로그인(화면 공유가 도움됨)하여 한 번 `imsg chats --limit 1` / `imsg send ...` 를 실행하고 프롬프트를 승인한 뒤 다시 시도하십시오. [macOS 개인정보 보호 및 보안 TCC 문제 해결](#troubleshooting-macos-privacy-and-security-tcc)을 참고하십시오.

래퍼 예제(`chmod +x`). `<bot-macos-user>` 을 실제 macOS 사용자 이름으로 교체하십시오:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

설정 예제:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

단일 계정 설정의 경우 `accounts` 맵 대신 평면 옵션(`channels.imessage.cliPath`, `channels.imessage.dbPath`)을 사용하십시오.

### 원격/SSH 변형 (선택 사항)

다른 Mac 에서 iMessage 를 사용하려면, `channels.imessage.cliPath` 을 SSH 를 통해 원격 macOS 호스트에서 `imsg` 를 실행하는 래퍼로 설정하십시오. OpenClaw 는 stdio 만 필요합니다.

래퍼 예제:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**원격 첨부 파일:** `cliPath` 가 SSH 를 통해 원격 호스트를 가리키는 경우, Messages 데이터베이스의 첨부 파일 경로는 원격 머신의 파일을 참조합니다. `channels.imessage.remoteHost` 를 설정하면 OpenClaw 가 SCP 로 이를 자동으로 가져올 수 있습니다:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

`remoteHost` 가 설정되지 않은 경우, OpenClaw 는 래퍼 스크립트의 SSH 명령을 파싱하여 자동 감지를 시도합니다. 신뢰성을 위해 명시적 설정을 권장합니다.

#### Tailscale 을 통한 원격 Mac (예제)

Gateway(게이트웨이)가 Linux 호스트/VM 에서 실행되지만 iMessage 는 Mac 에서 실행되어야 한다면, Tailscale 이 가장 간단한 브리지입니다. Gateway(게이트웨이)는 tailnet 을 통해 Mac 과 통신하고, SSH 로 `imsg` 를 실행하며, SCP 로 첨부 파일을 다시 가져옵니다.

아키텍처:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

구체적인 설정 예제(Tailscale 호스트명):

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

래퍼 예제(`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

참고:

- Mac 이 Messages 에 로그인되어 있고 원격 로그인이 활성화되어 있는지 확인하십시오.
- `ssh bot@mac-mini.tailnet-1234.ts.net` 가 프롬프트 없이 동작하도록 SSH 키를 사용하십시오.
- `remoteHost` 는 SCP 가 첨부 파일을 가져올 수 있도록 SSH 대상과 일치해야 합니다.

다중 계정 지원: 계정별 설정과 선택적 `name` 를 사용하여 `channels.imessage.accounts` 를 활용하십시오. 공통 패턴은 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts)을 참고하십시오. `~/.openclaw/openclaw.json` 는 종종 토큰을 포함하므로 커밋하지 마십시오.

## 접근 제어 (다이렉트 메시지 + 그룹)

다이렉트 메시지:

- 기본값: `channels.imessage.dmPolicy = "pairing"`.
- 알 수 없는 발신자는 페어링 코드를 받으며, 승인될 때까지 메시지는 무시됩니다(코드는 1시간 후 만료).
- 승인 방법:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- 페어링은 iMessage 다이렉트 메시지의 기본 토큰 교환 방식입니다. 자세한 내용: [Pairing](/channels/pairing)

그룹:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `allowlist` 가 설정된 경우, `channels.imessage.groupAllowFrom` 이 그룹에서 트리거할 수 있는 사용자를 제어합니다.
- iMessage 에는 네이티브 멘션 메타데이터가 없으므로, 멘션 게이팅은 `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`)를 사용합니다.
- 다중 에이전트 오버라이드: `agents.list[].groupChat.mentionPatterns` 에 에이전트별 패턴을 설정합니다.

## 동작 방식 (행동)

- `imsg` 가 메시지 이벤트를 스트리밍하며, Gateway(게이트웨이)가 이를 공유 채널 엔벨로프로 정규화합니다.
- 답장은 항상 동일한 채팅 ID 또는 핸들로 라우팅됩니다.

## 그룹 유사 스레드 (`is_group=false`)

일부 iMessage 스레드는 여러 참여자를 가질 수 있지만, Messages 가 채팅 식별자를 저장하는 방식에 따라 `is_group=false` 와 함께 도착할 수 있습니다.

`channels.imessage.groups` 아래에 `chat_id` 를 명시적으로 구성하면, OpenClaw 는 해당 스레드를 다음 용도로 '그룹'으로 취급합니다:

- 세션 분리(별도의 `agent:<agentId>:imessage:group:<chat_id>` 세션 키)
- 그룹 허용 목록 / 멘션 게이팅 동작

예제:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

이는 특정 스레드에 대해 분리된 성격/모델을 원할 때 유용합니다([다중 에이전트 라우팅](/concepts/multi-agent) 참고). 파일 시스템 격리에 대해서는 [Sandboxing](/gateway/sandboxing)을 참고하십시오.

## 미디어 + 제한

- `channels.imessage.includeAttachments` 를 통한 선택적 첨부 파일 수집.
- `channels.imessage.mediaMaxMb` 를 통한 미디어 상한.

## 제한

- 아웃바운드 텍스트는 `channels.imessage.textChunkLimit` 으로 청크 처리됩니다(기본값 4000).
- 선택적 줄바꿈 청크 처리: `channels.imessage.chunkMode="newline"` 를 설정하면 길이 기준 청크 처리 전에 빈 줄(문단 경계)에서 분할합니다.
- 미디어 업로드는 `channels.imessage.mediaMaxMb` 로 제한됩니다(기본값 16).

## 주소 지정 / 전송 대상

안정적인 라우팅을 위해 `chat_id` 를 권장합니다:

- `chat_id:123` (권장)
- `chat_guid:...`
- `chat_identifier:...`
- 직접 핸들: `imessage:+1555` / `sms:+1555` / `user@example.com`

채팅 목록:

```
imsg chats --limit 20
```

## 설정 참조 (iMessage)

전체 설정: [Configuration](/gateway/configuration)

프로바이더 옵션:

- `channels.imessage.enabled`: 채널 시작 활성화/비활성화.
- `channels.imessage.cliPath`: `imsg` 경로.
- `channels.imessage.dbPath`: Messages DB 경로.
- `channels.imessage.remoteHost`: `cliPath` 가 원격 Mac 을 가리킬 때(예: `user@gateway-host`) 첨부 파일 전송을 위한 SCP 의 SSH 호스트. 설정되지 않은 경우 SSH 래퍼에서 자동 감지됩니다.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: SMS 지역.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.imessage.allowFrom`: 다이렉트 메시지 허용 목록(핸들, 이메일, E.164 번호 또는 `chat_id:*`). `open` 는 `"*"` 가 필요합니다. iMessage 에는 사용자 이름이 없으므로 핸들이나 채팅 대상을 사용하십시오.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (기본값: 허용 목록).
- `channels.imessage.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: 컨텍스트에 포함할 최대 그룹 메시지 수(0 은 비활성화).
- `channels.imessage.dmHistoryLimit`: 사용자 턴 기준의 다이렉트 메시지 히스토리 제한. 사용자별 오버라이드: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: 그룹별 기본값 + 허용 목록(`"*"` 를 전역 기본값으로 사용).
- `channels.imessage.includeAttachments`: 첨부 파일을 컨텍스트로 수집.
- `channels.imessage.mediaMaxMb`: 인바운드/아웃바운드 미디어 상한(MB).
- `channels.imessage.textChunkLimit`: 아웃바운드 청크 크기(문자 수).
- `channels.imessage.chunkMode`: 길이 기준 청크 처리 전에 빈 줄(문단 경계)에서 분할하기 위한 `length` (기본값) 또는 `newline`.

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
