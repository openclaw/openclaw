---
read_when:
    - BlueBubbles 채널 설정
    - 웹훅 페어링 문제 해결
    - macOS에서 iMessage 구성
summary: BlueBubbles macOS 서버를 통한 iMessage(REST 보내기/받기, 입력, 반응, 페어링, 고급 동작).
title: 블루버블스
x-i18n:
    generated_at: "2026-02-08T15:49:15Z"
    model: gtx
    provider: google-translate
    source_hash: a5208867c934460ad97e9273953935839c0754a61f84a5c68ef8aa4805b6b61c
    source_path: channels/bluebubbles.md
    workflow: 15
---

# BlueBubbles(macOS REST)

상태: HTTP를 통해 BlueBubbles macOS 서버와 통신하는 번들 플러그인입니다. **iMessage 통합에 권장됨** 레거시 imsg 채널에 비해 더 풍부한 API와 더 쉬운 설정 덕분입니다.

## 개요

- BlueBubbles 도우미 앱을 통해 macOS에서 실행됩니다([bluebubbles.app](https://bluebubbles.app)).
- 권장/테스트됨: macOS Sequoia(15). macOS Tahoe(26)가 작동합니다. 현재 Tahoe에서는 편집이 손상되었으며 그룹 아이콘 업데이트가 성공을 보고하지만 동기화되지 않을 수 있습니다.
- OpenClaw는 REST API(`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- 수신 메시지는 웹후크를 통해 도착합니다. 발신 응답, 입력 표시기, 읽음 확인 및 탭백은 REST 호출입니다.
- 첨부 파일과 스티커는 인바운드 미디어로 수집됩니다(가능한 경우 상담원에게 표시됩니다).
- 페어링/허용 목록은 다른 채널과 동일한 방식으로 작동합니다(`/channels/pairing` 등)으로 `channels.bluebubbles.allowFrom` + 페어링 코드.
- 반응은 Slack/Telegram과 마찬가지로 시스템 이벤트로 표시되므로 상담원은 응답하기 전에 이를 "멘션"할 수 있습니다.
- 고급 기능: 편집, 전송 취소, 회신 스레딩, 메시지 효과, 그룹 관리.

## 빠른 시작

1. Mac에 BlueBubbles 서버를 설치합니다(다음 지침을 따르세요). [bluebubbles.app/install](https://bluebubbles.app/install)).
2. BlueBubbles 구성에서 웹 API를 활성화하고 비밀번호를 설정합니다.
3. 달리다 `openclaw onboard` BlueBubbles를 선택하거나 수동으로 구성합니다.

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

4. BlueBubbles 웹훅이 게이트웨이를 가리키도록 합니다(예: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).
5. 게이트웨이를 시작하십시오. 웹훅 핸들러를 등록하고 페어링을 시작합니다.

## Messages.app 활성 상태 유지(VM/헤드리스 설정)

일부 macOS VM/상시 켜짐 설정은 Messages.app이 "유휴" 상태로 끝날 수 있습니다(앱이 열리거나 포그라운드될 때까지 수신 이벤트가 중지됨). 간단한 해결 방법은 다음과 같습니다. **5분마다 메시지 찔러보기** AppleScript + LaunchAgent를 사용합니다.

### 1) AppleScript 저장

다음 이름으로 저장하세요.

- `~/Scripts/poke-messages.scpt`

예제 스크립트(비대화형, 포커스를 훔치지 않음):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2) LaunchAgent 설치

다음 이름으로 저장하세요.

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

참고:

- 이것은 실행됩니다 **300초마다** 그리고 **로그인 시**.
- 첫 번째 실행으로 인해 macOS가 실행될 수 있음 **오토메이션** 프롬프트(`osascript` → 메시지). LaunchAgent를 실행하는 동일한 사용자 세션에서 이를 승인하십시오.

로드:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## 온보딩

BlueBubbles는 대화형 설정 마법사에서 사용할 수 있습니다.

```
openclaw onboard
```

마법사는 다음을 묻는 메시지를 표시합니다.

- **서버 URL** (필수): BlueBubbles 서버 주소(예: `http://192.168.1.100:1234`)
- **비밀번호** (필수): BlueBubbles 서버 설정의 API 비밀번호
- **웹훅 경로** (선택 사항): 기본값은 다음과 같습니다. `/bluebubbles-webhook`
- **DM 정책**: 페어링, 허용 목록, 열기 또는 비활성화됨
- **허용 목록**: 전화번호, 이메일, 채팅 대상

CLI를 통해 BlueBubbles를 추가할 수도 있습니다.

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## 액세스 제어(DM + 그룹)

DM:

- 기본: `channels.bluebubbles.dmPolicy = "pairing"`.
- 알 수 없는 발신자는 페어링 코드를 받습니다. 메시지는 승인될 때까지 무시됩니다(코드는 1시간 후에 만료됩니다).
- 승인 방법:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- 페어링은 기본 토큰 교환입니다. 세부: [편성](/channels/pairing)

여러 떼:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (기본: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` 다음과 같은 경우에 그룹으로 트리거할 수 있는 사람을 제어합니다. `allowlist` 설정됩니다.

### 게이팅 언급(그룹)

BlueBubbles는 iMessage/WhatsApp 동작과 일치하는 그룹 채팅에 대한 멘션 게이팅을 지원합니다.

- 용도 `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`) 멘션을 감지합니다.
- 언제 `requireMention` 그룹에 대해 활성화된 경우 상담원은 언급된 경우에만 응답합니다.
- 승인된 발신자의 제어 명령은 멘션 게이팅을 우회합니다.

그룹별 구성:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### 명령 게이팅

- 제어 명령(예: `/config`, `/model`) 승인이 필요합니다.
- 용도 `allowFrom` 그리고 `groupAllowFrom` 명령 권한 부여를 결정합니다.
- 인증된 발신자는 그룹에서 언급하지 않아도 제어 명령을 실행할 수 있습니다.

## 타이핑 + 읽음 확인

- **입력 표시기**: 응답 생성 전과 생성 중에 자동으로 전송됩니다.
- **읽음 확인**: 다음에 의해 제어됨 `channels.bluebubbles.sendReadReceipts` (기본: `true`).
- **입력 표시기**: OpenClaw는 타이핑 시작 이벤트를 보냅니다. BlueBubbles는 전송 또는 시간 초과 시 자동으로 입력을 지웁니다(DELETE를 통한 수동 중지는 신뢰할 수 없음).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## 고급 동작

BlueBubbles는 구성에서 활성화되면 고급 메시지 작업을 지원합니다.

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

사용 가능한 작업:

- **반응하다**: 탭백 반응 추가/제거(`messageId`, `emoji`, `remove`)
- **편집하다**: 보낸 메시지를 편집합니다(`messageId`, `text`)
- **보내지 않음**: 메시지 보내기 취소(`messageId`)
- **회신하다**: 특정 메시지에 답장합니다(`messageId`, `text`, `to`)
- **sendWithEffect**: iMessage 효과로 보내기(`text`, `to`, `effectId`)
- **그룹 이름 바꾸기**: 그룹 채팅 이름 바꾸기(`chatGuid`, `displayName`)
- **세트그룹아이콘**: 그룹채팅 아이콘/사진 설정(`chatGuid`, `media`) — macOS 26 Tahoe에서 불안정함(API가 성공을 반환할 수 있지만 아이콘이 동기화되지 않음)
- **참가자 추가**: 그룹에 사용자 추가(`chatGuid`, `address`)
- **제거참가자**: 그룹에서 누군가를 제거합니다(`chatGuid`, `address`)
- **그룹 탈퇴**: 그룹 채팅에서 나가기 (`chatGuid`)
- **첨부파일 보내기**: 미디어/파일 보내기(`to`, `buffer`, `filename`, `asVoice`)
  - 음성 메모: 설정 `asVoice: true` ~와 함께 **MP3** 또는 **CAF** iMessage 음성 메시지로 보낼 오디오. BlueBubbles는 음성 메모를 보낼 때 MP3 → CAF로 변환합니다.

### 메시지 ID(짧은 것 vs 전체)

OpenClaw가 표면화될 수 있음 _짧은_ 메시지 ID(예: `1`, `2`) 토큰을 저장합니다.

- `MessageSid` / `ReplyToId` 짧은 ID일 수 있습니다.
- `MessageSidFull` / `ReplyToIdFull` 공급자 전체 ID를 포함합니다.
- 짧은 ID는 메모리 내에 있습니다. 다시 시작하거나 캐시를 제거하면 만료될 수 있습니다.
- 작업은 짧거나 전체를 허용합니다. `messageId`하지만 짧은 ID를 더 이상 사용할 수 없으면 오류가 발생합니다.

내구성 있는 자동화 및 저장을 위해 전체 ID를 사용하십시오.

- 템플릿: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- 문맥: `MessageSidFull` / `ReplyToIdFull` 인바운드 페이로드에서

보다 [구성](/gateway/configuration) 템플릿 변수의 경우.

## 스트리밍 차단

응답을 단일 메시지로 보낼지 아니면 블록 단위로 스트리밍할지 제어합니다.

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## 미디어 + 제한

- 인바운드 첨부 파일은 다운로드되어 미디어 캐시에 저장됩니다.
- 미디어 캡을 통해 `channels.bluebubbles.mediaMaxMb` (기본값: 8MB)
- 아웃바운드 텍스트는 다음과 같이 청크됩니다. `channels.bluebubbles.textChunkLimit` (기본값: 4000자)

## 구성 참조

전체 구성: [구성](/gateway/configuration)

제공업체 옵션:

- `channels.bluebubbles.enabled`: 채널을 활성화/비활성화합니다.
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API 기본 URL.
- `channels.bluebubbles.password`: API 비밀번호.
- `channels.bluebubbles.webhookPath`: 웹훅 엔드포인트 경로(기본값: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (기본: `pairing`).
- `channels.bluebubbles.allowFrom`: DM 허용 목록(핸들, 이메일, E.164 번호, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (기본: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: 그룹 발신자 허용 목록입니다.
- `channels.bluebubbles.groups`: 그룹별 구성(`requireMention`, 등.).
- `channels.bluebubbles.sendReadReceipts`: 읽음 확인 보내기(기본값: `true`).
- `channels.bluebubbles.blockStreaming`: 블록 스트리밍 활성화(기본값: `false`; 스트리밍 응답에 필요함).
- `channels.bluebubbles.textChunkLimit`: 아웃바운드 청크 크기(문자)(기본값: 4000)
- `channels.bluebubbles.chunkMode`: `length` (기본값) 초과하는 경우에만 분할 `textChunkLimit`; `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할됩니다.
- `channels.bluebubbles.mediaMaxMb`: 인바운드 미디어 한도(MB)(기본값: 8).
- `channels.bluebubbles.historyLimit`: 컨텍스트에 대한 최대 그룹 메시지입니다(0은 비활성화됨).
- `channels.bluebubbles.dmHistoryLimit`: DM 기록 제한입니다.
- `channels.bluebubbles.actions`: 특정 작업을 활성화/비활성화합니다.
- `channels.bluebubbles.accounts`: 다중 계정 구성.

관련 전역 옵션:

- `agents.list[].groupChat.mentionPatterns` (또는 `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## 주소 지정 / 전달 대상

선호하다 `chat_guid` 안정적인 라우팅을 위해:

- `chat_guid:iMessage;-;+15555550123` (그룹에 선호됨)
- `chat_id:123`
- `chat_identifier:...`
- 직접 핸들: `+15555550123`, `user@example.com`
  - 직접 핸들에 기존 DM 채팅이 없는 경우 OpenClaw는 다음을 통해 DM 채팅을 생성합니다. `POST /api/v1/chat/new`. 이를 위해서는 BlueBubbles Private API를 활성화해야 합니다.

## 보안

- 웹훅 요청은 비교를 통해 인증됩니다. `guid` / `password` 쿼리 매개변수 또는 헤더 `channels.bluebubbles.password`. 요청 대상 `localhost` 또한 허용됩니다.
- API 비밀번호와 웹훅 엔드포인트를 비밀로 유지하세요(자격 증명처럼 취급하세요).
- 로컬 호스트 신뢰는 동일한 호스트 역방향 프록시가 실수로 비밀번호를 우회할 수 있음을 의미합니다. 게이트웨이를 프록시하는 경우 프록시에서 인증을 요구하고 구성합니다. `gateway.trustedProxies`. 보다 [게이트웨이 보안](/gateway/security#reverse-proxy-configuration).
- LAN 외부에 노출하는 경우 BlueBubbles 서버에서 HTTPS + 방화벽 규칙을 활성화하세요.

## 문제 해결

- 입력/읽기 이벤트가 작동하지 않는 경우 BlueBubbles 웹후크 로그를 확인하고 게이트웨이 경로가 일치하는지 확인하세요. `channels.bluebubbles.webhookPath`.
- 페어링 코드는 1시간 후에 만료됩니다. 사용 `openclaw pairing list bluebubbles` 그리고 `openclaw pairing approve bluebubbles <code>`.
- 반응에는 BlueBubbles 비공개 API(`POST /api/v1/message/react`); 서버 버전에서 이를 노출하는지 확인하세요.
- 편집/전송 취소에는 macOS 13 이상 및 호환되는 BlueBubbles 서버 버전이 필요합니다. macOS 26(Tahoe)에서는 현재 비공개 API 변경으로 인해 편집이 중단되었습니다.
- macOS 26(Tahoe)에서는 그룹 아이콘 업데이트가 불안정할 수 있습니다. API가 성공을 반환할 수 있지만 새 아이콘이 동기화되지 않습니다.
- OpenClaw는 BlueBubbles 서버의 macOS 버전을 기반으로 알려진 손상된 작업을 자동으로 숨깁니다. macOS 26(Tahoe)에서 편집 내용이 계속 나타나면 다음을 사용하여 수동으로 비활성화하세요. `channels.bluebubbles.actions.edit=false`.
- 상태/건강 정보: `openclaw status --all` 또는 `openclaw status --deep`.

일반 채널 워크플로 참조는 다음을 참조하세요. [채널](/channels) 그리고 [플러그인](/tools/plugin) 가이드.
