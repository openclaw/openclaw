---
read_when:
    - iMessage 지원 설정
    - iMessage 보내기/받기 디버깅
summary: imsg를 통한 기존 iMessage 지원(stdio를 통한 JSON-RPC) 새로운 설정에서는 BlueBubbles를 사용해야 합니다.
title: 아이메시지
x-i18n:
    generated_at: "2026-02-08T15:49:19Z"
    model: gtx
    provider: google-translate
    source_hash: b418a589547d1ef096b917d5d668ec2fff152c48bc9cf3a137abb46bce1b71ad
    source_path: channels/imessage.md
    workflow: 15
---

# iMessage(기존: imsg)

> **권장사항:** 사용 [블루버블스](/channels/bluebubbles) 새로운 iMessage 설정을 위해.
>
> 그만큼 `imsg` 채널은 레거시 외부 CLI 통합이며 향후 릴리스에서 제거될 수 있습니다.

상태: 레거시 외부 CLI 통합. 게이트웨이 생성 `imsg rpc` (stdio를 통한 JSON-RPC).

## 빠른 설정(초보자)

1. 이 Mac에 메시지가 로그인되어 있는지 확인하세요.
2. 설치하다 `imsg`:
   - `brew install steipete/tap/imsg`
3. 다음으로 OpenClaw 구성 `channels.imessage.cliPath` 그리고 `channels.imessage.dbPath`.
4. 게이트웨이를 시작하고 macOS 프롬프트를 승인합니다(자동화 + 전체 디스크 액세스).

최소 구성:

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

## 그것은 무엇입니까

- iMessage 채널 지원 `imsg` macOS에서.
- 결정적 라우팅: 답장은 항상 iMessage로 돌아갑니다.
- DM은 상담원의 기본 세션을 공유합니다. 그룹은 격리되어 있습니다(`agent:<agentId>:imessage:group:<chat_id>`).
- 다중 참가자 스레드가 다음과 같이 도착하는 경우 `is_group=false`, 여전히 다음을 통해 격리할 수 있습니다. `chat_id` 사용하여 `channels.imessage.groups` (아래의 "그룹 같은 스레드" 참조)

## 구성 쓰기

기본적으로 iMessage는 다음에 의해 트리거되는 구성 업데이트를 쓸 수 있습니다. `/config set|unset` (요구 `commands.config: true`).

다음을 사용하여 비활성화:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## 요구사항

- 메시지가 로그인된 macOS.
- OpenClaw +에 대한 전체 디스크 액세스 `imsg` (메시지 DB 접근).
- 보낼 때 자동화 권한입니다.
- `channels.imessage.cliPath` stdin/stdout을 프록시하는 모든 명령(예: 다른 Mac에 SSH로 연결하여 실행하는 래퍼 스크립트)을 가리킬 수 있습니다. `imsg rpc`).

## macOS 개인 정보 보호 및 보안 TCC 문제 해결

전송/수신에 실패하는 경우(예: `imsg rpc` 0이 아닌 값으로 종료되거나 시간 초과되거나 게이트웨이가 중단된 것처럼 보임), 일반적인 원인은 승인되지 않은 macOS 권한 프롬프트입니다.

macOS는 앱/프로세스 컨텍스트별로 TCC 권한을 부여합니다. 실행되는 동일한 컨텍스트에서 프롬프트 승인 `imsg` (예: Terminal/iTerm, LaunchAgent 세션 또는 SSH 실행 프로세스)

체크리스트:

- **전체 디스크 액세스**: OpenClaw를 실행하는 프로세스(및 OpenClaw를 실행하는 모든 셸/SSH 래퍼)에 대한 액세스를 허용합니다. `imsg`). 이는 메시지 데이터베이스(`chat.db`).
- **자동화 → 메시지**: OpenClaw(및/또는 터미널)를 실행하는 프로세스가 제어하도록 허용합니다. **메시지.앱** 아웃바운드 전송의 경우.
- **`imsg` CLI 상태**: 확인하다 `imsg` 이 설치되어 RPC를 지원합니다(`imsg rpc --help`).

팁: OpenClaw가 헤드리스(LaunchAgent/systemd/SSH)로 실행되는 경우 macOS 프롬프트를 놓치기 쉽습니다. GUI 터미널에서 일회성 대화형 명령을 실행하여 프롬프트를 강제로 표시한 후 다시 시도하십시오.

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

관련 macOS 폴더 권한(데스크탑/문서/다운로드): [/플랫폼/mac/권한](/platforms/mac/permissions).

## 설정(빠른 경로)

1. 이 Mac에 메시지가 로그인되어 있는지 확인하세요.
2. iMessage를 구성하고 게이트웨이를 시작하십시오.

### 전용 봇 macOS 사용자(격리된 ID용)

봇이 다음에서 전송하도록 하려는 경우 **별도의 iMessage ID** (그리고 개인 메시지를 깔끔하게 유지하세요) 전용 Apple ID + 전용 macOS 사용자를 사용하세요.

1. 전용 Apple ID를 생성합니다(예: `my-cool-bot@icloud.com`).
   - Apple에서는 확인/2FA를 위해 전화번호를 요구할 수 있습니다.
2. macOS 사용자를 생성합니다(예: `openclawhome`) 로그인하고 로그인하세요.
3. 해당 macOS 사용자에서 메시지를 열고 봇 Apple ID를 사용하여 iMessage에 로그인합니다.
4. 원격 로그인을 활성화합니다(시스템 설정 → 일반 → 공유 → 원격 로그인).
5. 설치하다 `imsg`:
   - `brew install steipete/tap/imsg`
6. SSH를 설정하여 `ssh <bot-macos-user>@localhost true` 비밀번호 없이 작동합니다.
7. 가리키다 `channels.imessage.accounts.bot.cliPath` 실행되는 SSH 래퍼에서 `imsg` 봇 사용자로서.

첫 실행 참고 사항: 보내기/받기에는 GUI 승인(자동화 + 전체 디스크 액세스)이 필요할 수 있습니다. _봇 macOS 사용자_. 만약에 `imsg rpc` 멈추거나 종료되는 경우 해당 사용자로 로그인하고(화면 공유 지원) 일회성 실행 `imsg chats --limit 1` / `imsg send ...`, 메시지를 승인한 후 다시 시도하세요. 보다 [macOS 개인 정보 보호 및 보안 TCC 문제 해결](#troubleshooting-macos-privacy-and-security-tcc).

예제 래퍼(`chmod +x`). 바꾸다 `<bot-macos-user>` 실제 macOS 사용자 이름으로:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

예시 구성:

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

단일 계정 설정의 경우 플랫 옵션(`channels.imessage.cliPath`, `channels.imessage.dbPath`) 대신 `accounts` 지도.

### 원격/SSH 변형(선택 사항)

다른 Mac에서 iMessage를 사용하려면 다음을 설정하세요. `channels.imessage.cliPath` 실행되는 래퍼에 `imsg` SSH를 통해 원격 macOS 호스트에서. OpenClaw에는 stdio만 필요합니다.

예시 래퍼:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**원격 첨부 파일:** 언제 `cliPath` SSH를 통해 원격 호스트, 원격 시스템에 있는 메시지 데이터베이스 참조 파일의 첨부 경로를 가리킵니다. OpenClaw는 다음을 설정하여 자동으로 SCP를 통해 이러한 항목을 가져올 수 있습니다. `channels.imessage.remoteHost`:

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

만약에 `remoteHost` 설정되지 않은 경우 OpenClaw는 래퍼 스크립트에서 SSH 명령을 구문 분석하여 이를 자동 감지하려고 시도합니다. 안정성을 위해 명시적 구성을 권장합니다.

#### Tailscale을 통한 원격 Mac(예)

게이트웨이가 Linux 호스트/VM에서 실행되지만 iMessage는 Mac에서 실행되어야 하는 경우 Tailscale이 가장 간단한 브리지입니다. 게이트웨이는 tailnet을 통해 Mac과 통신하고 `imsg` SSH를 통해 SCPs 첨부 파일을 다시 보냅니다.

건축학:

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

구체적인 구성 예(Tailscale 호스트 이름):

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

예제 래퍼(`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

참고:

- Mac이 메시지에 로그인되어 있고 원격 로그인이 활성화되어 있는지 확인하세요.
- SSH 키를 사용하여 `ssh bot@mac-mini.tailnet-1234.ts.net` 프롬프트 없이 작동합니다.
- `remoteHost` SCP가 첨부 파일을 가져올 수 있도록 SSH 대상과 일치해야 합니다.

다중 계정 지원: 사용 `channels.imessage.accounts` 계정별 구성 및 선택 사항 포함 `name`. 보다 [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) 공유 패턴의 경우. 커밋하지 마세요 `~/.openclaw/openclaw.json` (종종 토큰이 포함되어 있음)

## 액세스 제어(DM + 그룹)

DM:

- 기본: `channels.imessage.dmPolicy = "pairing"`.
- 알 수 없는 발신자는 페어링 코드를 받습니다. 메시지는 승인될 때까지 무시됩니다(코드는 1시간 후에 만료됩니다).
- 승인 방법:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- 페어링은 iMessage DM의 기본 토큰 교환입니다. 세부: [편성](/channels/pairing)

여러 떼:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` 다음과 같은 경우에 그룹으로 트리거할 수 있는 사람을 제어합니다. `allowlist` 설정됩니다.
- 게이팅 사용 언급 `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`) iMessage에는 기본 멘션 메타데이터가 없기 때문입니다.
- 다중 에이전트 재정의: 에이전트별 패턴 설정 `agents.list[].groupChat.mentionPatterns`.

## 작동 방식(행동)

- `imsg` 메시지 이벤트를 스트리밍합니다. 게이트웨이는 이를 공유 채널 봉투로 정규화합니다.
- 응답은 항상 동일한 채팅 ID 또는 핸들로 다시 라우팅됩니다.

## 그룹 같은 스레드(`is_group=false`)

일부 iMessage 스레드에는 여러 참가자가 있을 수 있지만 여전히 `is_group=false` 메시지가 채팅 식별자를 저장하는 방법에 따라 다릅니다.

명시적으로 구성하는 경우 `chat_id` 아래에 `channels.imessage.groups`, OpenClaw는 해당 스레드를 다음에 대한 "그룹"으로 처리합니다.

- 세션 격리(별도 `agent:<agentId>:imessage:group:<chat_id>` 세션 키)
- 그룹 허용 목록 / 게이팅 동작 언급

예:

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

이는 특정 스레드에 대해 격리된 성격/모델을 원할 때 유용합니다(참조 [다중 에이전트 라우팅](/concepts/multi-agent)). 파일 시스템 격리에 대해서는 다음을 참조하세요. [샌드박싱](/gateway/sandboxing).

## 미디어 + 제한

- 다음을 통한 선택적 첨부 파일 수집 `channels.imessage.includeAttachments`.
- 미디어 캡을 통해 `channels.imessage.mediaMaxMb`.

## 제한

- 아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.imessage.textChunkLimit` (기본값은 4000).
- 선택적 개행 청킹: 설정 `channels.imessage.chunkMode="newline"` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.
- 미디어 업로드는 다음으로 제한됩니다. `channels.imessage.mediaMaxMb` (기본값 16).

## 주소 지정 / 전달 대상

선호하다 `chat_id` 안정적인 라우팅을 위해:

- `chat_id:123` (우선의)
- `chat_guid:...`
- `chat_identifier:...`
- 직접 핸들: `imessage:+1555` / `sms:+1555` / `user@example.com`

채팅 나열:

```
imsg chats --limit 20
```

## 구성 참조(iMessage)

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.imessage.enabled`: 채널 시작을 활성화/비활성화합니다.
- `channels.imessage.cliPath`: 경로 `imsg`.
- `channels.imessage.dbPath`: 메시지 DB 경로입니다.
- `channels.imessage.remoteHost`: SCP 첨부 파일 전송을 위한 SSH 호스트 `cliPath` 원격 Mac을 가리킵니다(예: `user@gateway-host`). 설정되지 않은 경우 SSH 래퍼에서 자동 감지됩니다.
- `channels.imessage.service`:`imessage | sms | auto`.
- `channels.imessage.region`: SMS 지역.
- `channels.imessage.dmPolicy`:`pairing | allowlist | open | disabled` (기본값: 페어링).
- `channels.imessage.allowFrom`: DM 허용 목록(핸들, 이메일, E.164 번호 또는 `chat_id:*`).`open` 필요하다 `"*"`. iMessage에는 사용자 이름이 없습니다. 핸들이나 채팅 대상을 사용하세요.
- `channels.imessage.groupPolicy`:`open | allowlist | disabled` (기본값: 허용 목록).
- `channels.imessage.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: 컨텍스트로 포함할 최대 그룹 메시지입니다(0은 비활성화됨).
- `channels.imessage.dmHistoryLimit`: 사용자 턴의 DM 기록 제한입니다. 사용자별 재정의: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: 그룹별 기본값 + 허용 목록(사용 `"*"` 전역 기본값의 경우).
- `channels.imessage.includeAttachments`: 첨부 파일을 컨텍스트로 수집합니다.
- `channels.imessage.mediaMaxMb`: 인바운드/아웃바운드 미디어 캡(MB)입니다.
- `channels.imessage.textChunkLimit`: 아웃바운드 청크 크기(문자)입니다.
- `channels.imessage.chunkMode`:`length` (기본값) 또는 `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할합니다.

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
