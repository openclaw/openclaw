---
summary: "BlueBubbles macOS 서버를 통한 iMessage (REST 송/수신, 타이핑, 반응, 페어링, 고급 액션)."
read_when:
  - BlueBubbles 채널 설정
  - 웹훅 페어링 문제 해결
  - macOS에서 iMessage 구성
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

상태: HTTP를 통해 BlueBubbles macOS 서버와 통신하는 번들 플러그인. 더 풍부한 API와 더 쉬운 설정 덕분에 **iMessage 통합을 권장**합니다. 이는 기존 imsg 채널보다 우수합니다.

## 개요

- BlueBubbles 보조 앱 ([bluebubbles.app](https://bluebubbles.app))을 통해 macOS에서 실행됩니다.
- 권장/테스트됨: macOS Sequoia (15). macOS Tahoe (26)에서 동작하지만, Tahoe에서는 편집이 현재 고장 나 있으며 그룹 아이콘 업데이트가 성공을 보고할 수 있지만 동기화되지 않을 수 있습니다.
- OpenClaw는 REST API를 통해 통신합니다 (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- 수신 메시지는 웹훅을 통해 도착하며, 발신 응답, 타이핑 지표, 읽은 티켓, 반응은 REST 호출을 통해 처리됩니다.
- 첨부 파일과 스티커는 수신 미디어로 처리됩니다 (가능한 경우 에이전트에게 전달).
- 페어링/허용 목록은 다른 채널과 동일하게 작동합니다 (`/channels/pairing` 등) `channels.bluebubbles.allowFrom` + 페어링 코드로.
- 반응은 Slack/Telegram과 같은 시스템 이벤트로 나타나 에이전트가 답변 전 "언급"할 수 있습니다.
- 고급 기능: 편집, 보내기 취소, 답변 스레딩, 메시지 효과, 그룹 관리.

## 시작하기

1. Mac에 BlueBubbles 서버를 설치합니다 (지침은 [bluebubbles.app/install](https://bluebubbles.app/install) 참조).
2. BlueBubbles 설정에서 웹 API를 활성화하고 비밀번호를 설정합니다.
3. `openclaw onboard`를 실행하고 BlueBubbles를 선택하거나 수동으로 구성:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. BlueBubbles 웹훅을 게이트웨이로 지정합니다 (예: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).
5. 게이트웨이를 시작하면 웹훅 핸들러가 등록되고 페어링이 시작됩니다.

보안 주의사항:

- 항상 웹훅 비밀번호를 설정하십시오. 게이트웨이를 리버스 프록시 (Tailscale Serve/Funnel, nginx, Cloudflare Tunnel, ngrok)를 통해 노출하는 경우 프록시는 로컬 루프백을 통해 게이트웨이와 연결할 수 있습니다. BlueBubbles 웹훅 핸들러는 프록시된 것으로 간주되는 요청을 수락하지 않습니다.

## Messages.app 활성 유지 (VM / 헤드리스 설정)

일부 macOS VM / 항상 켜진 설정은 Messages.app가 "대기" 상태로 잔존 할 수 있습니다 (앱을 열거나 전경에 두지 않으면 수신 이벤트가 정지). 간단한 해결책은 **AppleScript + LaunchAgent를 사용하여 매 5분마다 Messages를 조작하는 것**입니다.

### 1) AppleScript 저장

다음으로 저장합니다:

- `~/Scripts/poke-messages.scpt`

예제 스크립트 (비대화형, 초점을 뺏지 않음):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- 프로세스를 응답성 있게 유지하기 위해 스크립팅 인터페이스를 조작.
    set _chatCount to (count of chats)
  end tell
on error
  -- 일시적인 오류 무시 (첫 실행의 프롬프트, 잠긴 세션 등).
end try
```

### 2) LaunchAgent 설치

다음으로 저장합니다:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

노트:

- 이것은 **매 300초** 및 **로그인 시** 실행됩니다.
- 첫 실행은 macOS **자동화** 프롬프트를 트리거할 수 있습니다 (`osascript` → Messages). LaunchAgent를 실행하는 동일한 사용자 세션에서 이를 승인하십시오.

로딩:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## 온보딩

BlueBubbles는 인터랙티브 설정 마법사에서 사용할 수 있습니다:

```
openclaw onboard
```

마법사에서는 다음을 요청합니다:

- **서버 URL** (필수): BlueBubbles 서버 주소 (예: `http://192.168.1.100:1234`)
- **비밀번호** (필수): BlueBubbles 서버 설정의 API 비밀번호
- **웹훅 경로** (선택 사항): 기본값은 `/bluebubbles-webhook`
- **다이렉트 메시지 정책**: 페어링, 허용 목록, 오픈, 비활성화
- **허용 목록**: 전화번호, 이메일 주소 또는 채팅 대상

CLI를 통해 BlueBubbles를 추가할 수도 있습니다:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 액세스 제어 (다이렉트 메시지 + 그룹)

다이렉트 메시지:

- 기본값: `channels.bluebubbles.dmPolicy = "pairing"`.
- 알 수 없는 발신자는 페어링 코드를 받으며, 메시지는 승인될 때까지 무시됩니다 (코드는 1시간 후 만료).
- 승인 방법:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 페어링이 기본 토큰 교환입니다. 자세한 내용: [페어링](/channels/pairing)

그룹:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (기본값: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`은 `allowlist`가 설정된 경우 그룹 내 트리거를 허용할 수 있는 사용자를 제어합니다.

### 멘션 게이팅 (그룹)

BlueBubbles는 iMessage/WhatsApp 행동을 매칭하여 그룹 채팅에 대한 멘션 게이팅을 지원합니다:

- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`)를 사용하여 멘션을 감지합니다.
- 그룹에 대해 `requireMention`이 활성화되었을 때 에이전트는 멘션될 때만 응답합니다.
- 권한이 있는 발신자로부터의 제어 명령은 멘션 게이팅을 우회합니다.

그룹별 구성:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // 모든 그룹에 대한 기본값
        "iMessage;-;chat123": { requireMention: false }, // 특정 그룹에 대한 재정의
      },
    },
  },
}
```

### 명령 게이팅

- 제어 명령 (예: `/config`, `/model`)은 권한이 필요합니다.
- `allowFrom` 및 `groupAllowFrom`을 사용하여 명령 권한을 결정합니다.
- 권한이 있는 발신자는 그룹에서 멘션 없이도 제어 명령을 실행할 수 있습니다.

## 타이핑 + 읽음 확인

- **타이핑 지표**: 응답 생성 전후에 자동으로 전송됩니다.
- **읽음 확인**: `channels.bluebubbles.sendReadReceipts`로 제어됩니다 (기본값: `true`).
- **타이핑 지표**: OpenClaw는 타이핑 시작 이벤트를 전송하며, BlueBubbles는 자동으로 타임아웃 시 타이핑을 해제합니다 (DELETE를 통한 수동 중지는 신뢰할 수 없음).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // 읽음 확인 비활성화
    },
  },
}
```

## 고급 액션

BlueBubbles는 설정에서 활성화될 경우 고급 메시지 액션을 지원합니다:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // 탭백 (기본값: true)
        edit: true, // 전송한 메시지 편집 (macOS 13+, macOS 26 Tahoe에서 고장)
        unsend: true, // 메시지 보내기 취소 (macOS 13+)
        reply: true, // 메시지 GUID로 답변 스레딩
        sendWithEffect: true, // 메시지 효과 (슬램, 라우드 등)
        renameGroup: true, // 그룹 채팅 이름 변경
        setGroupIcon: true, // 그룹 채팅 아이콘/사진 설정 (macOS 26 Tahoe에서 불안정)
        addParticipant: true, // 그룹에 참가자 추가
        removeParticipant: true, // 그룹에서 참가자 제거
        leaveGroup: true, // 그룹 채팅 나가기
        sendAttachment: true, // 첨부 파일/미디어 전송
      },
    },
  },
}
```

사용 가능한 액션:

- **react**: 탭백 반응 추가/제거 (`messageId`, `emoji`, `remove`)
- **edit**: 전송된 메시지 편집 (`messageId`, `text`)
- **unsend**: 메시지 보내기 취소 (`messageId`)
- **reply**: 특정 메시지에 답변 (`messageId`, `text`, `to`)
- **sendWithEffect**: 메시지 효과와 함께 전송 (`text`, `to`, `effectId`)
- **renameGroup**: 그룹 채팅 이름 변경 (`chatGuid`, `displayName`)
- **setGroupIcon**: 그룹 채팅의 아이콘/사진 설정 (`chatGuid`, `media`) — macOS 26 Tahoe에서 불안정 (API는 성공을 반환할 수 있지만 아이콘이 동기화되지 않음).
- **addParticipant**: 그룹에 사람 추가 (`chatGuid`, `address`)
- **removeParticipant**: 그룹에서 사람 제거 (`chatGuid`, `address`)
- **leaveGroup**: 그룹 채팅 나가기 (`chatGuid`)
- **sendAttachment**: 미디어/파일 전송 (`to`, `buffer`, `filename`, `asVoice`)
  - 음성 메모: **MP3** 또는 **CAF** 오디오를 `asVoice: true`로 설정해 iMessage 음성 메시지를 작성합니다. BlueBubbles는 음성 메모 전송 시 MP3 → CAF를 변환합니다.

### 메시지 ID (짧은 vs 전체)

OpenClaw는 토큰을 절약하기 위해 _짧은_ 메시지 ID (예: `1`, `2`)를 사용합니다.

- `MessageSid` / `ReplyToId`는 짧은 ID일 수 있습니다.
- `MessageSidFull` / `ReplyToIdFull`은 프로바이더의 전체 ID를 포함합니다.
- 짧은 ID는 메모리에 저장되며, 재시작 또는 캐시 제거 시 만료될 수 있습니다.
- 액션은 짧은 또는 전체 `messageId`를 허용하지만, 짧은 ID는 더 이상 사용 가능하지 않을 경우 오류를 발생시킵니다.

내구성 있는 자동화 및 저장을 위해 전체 ID를 사용하십시오:

- 템플릿: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- 컨텍스트: 수신 페이로드에서 `MessageSidFull` / `ReplyToIdFull`

템플릿 변수에 대한 자세한 내용은 [구성](/gateway/configuration)을 참조하십시오.

## 블록 스트리밍

응답이 단일 메시지로 전송되거나 블록으로 스트리밍될지를 제어:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // 블록 스트리밍 활성화 (기본값: 비활성화)
    },
  },
}
```

## 미디어 + 제한

- 수신한 첨부 파일은 다운로드되어 미디어 캐시에 저장됩니다.
- 미디어 최대 용량은 `channels.bluebubbles.mediaMaxMb`를 통해 제한됩니다 (기본값: 8 MB).
- 발신 텍스트는 `channels.bluebubbles.textChunkLimit`으로 분할됩니다 (기본값: 4000자).

## 구성 참조

전체 구성: [구성](/gateway/configuration)

프로바이더 옵션:

- `channels.bluebubbles.enabled`: 채널 활성화/비활성화.
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API 기본 URL.
- `channels.bluebubbles.password`: API 비밀번호.
- `channels.bluebubbles.webhookPath`: 웹훅 엔드포인트 경로 (기본값: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (기본값: `pairing`).
- `channels.bluebubbles.allowFrom`: 다이렉트 메시지 허용 목록 (핸들, 이메일, E.164 번호, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (기본값: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: 그룹 발신자 허용 목록.
- `channels.bluebubbles.groups`: 그룹별 구성 (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: 읽음 확인 전송 (기본값: `true`).
- `channels.bluebubbles.blockStreaming`: 블록 스트리밍 활성화 (기본값: `false`; 스트리밍 응답에 필요).
- `channels.bluebubbles.textChunkLimit`: 발신 구분 문자 크기 (기본값: 4000자).
- `channels.bluebubbles.chunkMode`: `length` (기본값)은 `textChunkLimit`을 초과하는 경우 분할; `newline`은 길이 분할 전에 빈 줄 (단락 경계)에서 분할.
- `channels.bluebubbles.mediaMaxMb`: 수신 미디어 최대 용량 (기본값: 8).
- `channels.bluebubbles.mediaLocalRoots`: 아웃바운드 로컬 미디어 경로에 허용된 절대 로컬 디렉터리의 명시적 허용 목록. 로컬 경로 전송은 이것이 설정되지 않은 경우 기본적으로 거부됩니다. 계정별 재정의: `channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`.
- `channels.bluebubbles.historyLimit`: 컨텍스트를 위한 최대 그룹 메시지 (0은 비활성화).
- `channels.bluebubbles.dmHistoryLimit`: 다이렉트 메시지 히스토리 제한.
- `channels.bluebubbles.actions`: 특정 액션 활성화/비활성화.
- `channels.bluebubbles.accounts`: 다중 계정 구성.

관련 글로벌 옵션:

- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## 주소 지정 / 배송 대상

안정적인 라우팅을 위해 `chat_guid`를 선호:

- `chat_guid:iMessage;-;+15555550123` (그룹에 선호됨)
- `chat_id:123`
- `chat_identifier:...`
- 직접 핸들: `+15555550123`, `user@example.com`
  - 직접 핸들에 기존 다이렉트 메시지 채팅이 없으면 OpenClaw는 `POST /api/v1/chat/new`를 통해 하나를 생성합니다. 이는 BlueBubbles 비공개 API가 활성화되어 있어야 합니다.

## 보안

- 웹훅 요청은 `guid`/`password` 쿼리 매개변수 또는 헤더를 `channels.bluebubbles.password`와 비교하여 인증됩니다. `localhost`에서의 요청도 수락됩니다.
- API 비밀번호와 웹훅 엔드포인트를 비공개로 유지하십시오 (자격 증명처럼 취급).
- 로컬 호스트 신뢰는 동일한 호스트의 리버스 프록시가 비공식적으로 비밀번호를 우회할 수 있음을 의미합니다. 게이트웨이를 프록시하는 경우 프록시에서 인증을 요구하고 `gateway.trustedProxies`를 구성하십시오. [게이트웨이 보안](/gateway/security#reverse-proxy-configuration)을 참조하십시오.
- BlueBubbles 서버를 LAN 외부에 노출하는 경우 HTTPS + 방화벽 규칙을 활성화하십시오.

## 문제 해결

- 타이핑/읽기 이벤트가 작동하지 않을 경우, BlueBubbles 웹훅 로그를 확인하고 게이트웨이 경로가 `channels.bluebubbles.webhookPath`와 일치하는지 검증하십시오.
- 페어링 코드는 한 시간 후 만료됩니다; `openclaw pairing list bluebubbles` 및 `openclaw pairing approve bluebubbles <code>`를 사용하십시오.
- 반응은 BlueBubbles 비공개 API (`POST /api/v1/message/react`)가 필요합니다; 서버 버전이 이를 노출하는지 확인하십시오.
- 편집/보내기 취소는 macOS 13+ 및 호환되는 BlueBubbles 서버 버전이 필요합니다. macOS 26 (Tahoe)에서는 편집이 현재 비공개 API 변경으로 인해 고장 상태입니다.
- 그룹 아이콘 업데이트는 macOS 26 (Tahoe)에서 불안정할 수 있습니다: API는 성공을 반환하지만 새 아이콘이 동기화되지 않을 수 있습니다.
- OpenClaw는 BlueBubbles 서버의 macOS 버전에 기반하여 알려진 고장 액션을 자동으로 숨깁니다. macOS 26 (Tahoe)에서 편집이 여전히 나타날 경우, `channels.bluebubbles.actions.edit=false`로 수동 비활성화 하십시오.
- 상태/건강 정보를 위해: `openclaw status --all` 또는 `openclaw status --deep`.

일반적인 채널 워크플로 참조는 [채널](/channels) 및 [플러그인](/tools/plugin) 가이드를 확인하십시오.
