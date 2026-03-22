---
summary: "Mattermost 봇 설정 및 OpenClaw 구성"
read_when:
  - Mattermost 를 설정하는 경우
  - Mattermost 라우팅을 디버깅하는 경우
title: "Mattermost"
x-i18n:
  source_path: docs/channels/mattermost.md
---

# Mattermost (플러그인)

상태: 플러그인을 통해 지원됨 (봇 토큰 + WebSocket 이벤트). 채널, 그룹, DM 이 지원됩니다.
Mattermost 는 자체 호스팅 가능한 팀 메시징 플랫폼입니다. 제품 세부 사항과 다운로드는 [mattermost.com](https://mattermost.com) 공식 사이트를 참조하세요.

## 플러그인 필요

Mattermost 는 플러그인으로 제공되며 코어 설치에 번들되지 않습니다.

CLI 를 통한 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/mattermost
```

로컬 checkout (git 저장소에서 실행할 때):

```bash
openclaw plugins install ./extensions/mattermost
```

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정

1. Mattermost 플러그인을 설치합니다.
2. Mattermost 봇 계정을 만들고 **봇 토큰**을 복사합니다.
3. Mattermost **기본 URL** 을 복사합니다 (예: `https://chat.example.com`).
4. OpenClaw 를 구성하고 Gateway 를 시작합니다.

최소 구성:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## 네이티브 슬래시 명령

네이티브 슬래시 명령은 옵트인입니다. 활성화되면 OpenClaw 가 Mattermost API 를 통해 `oc_*` 슬래시 명령을 등록하고 Gateway HTTP 서버에서 콜백 POST 를 수신합니다.

## 환경 변수 (기본 계정)

Gateway 호스트에서 환경 변수를 선호하는 경우 설정합니다:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

환경 변수는 **기본** 계정 (`default`) 에만 적용됩니다.

## 채팅 모드

Mattermost 는 DM 에 자동으로 응답합니다. 채널 동작은 `chatmode` 로 제어됩니다:

- `oncall` (기본값): 채널에서 @멘션될 때만 응답합니다.
- `onmessage`: 모든 채널 메시지에 응답합니다.
- `onchar`: 메시지가 트리거 접두사로 시작할 때 응답합니다.

## 스레딩 및 세션

`channels.mattermost.replyToMode` 를 사용하여 채널 및 그룹 응답이 메인 채널에 남을지 트리거 게시물 아래 스레드를 시작할지 제어합니다.

- `off` (기본값): 인바운드 게시물이 이미 스레드에 있을 때만 스레드에서 응답합니다.
- `first`: 최상위 채널/그룹 게시물의 경우 해당 게시물 아래 스레드를 시작합니다.
- `all`: 현재 Mattermost 에서 `first` 와 동일한 동작입니다.

## 접근 제어 (DM)

- 기본값: `channels.mattermost.dmPolicy = "pairing"` (알 수 없는 발신자에게 페어링 코드 제공).
- 승인:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`

## 채널 (그룹)

- 기본값: `channels.mattermost.groupPolicy = "allowlist"` (멘션 게이팅).
- `channels.mattermost.groupAllowFrom` 으로 발신자를 허용합니다 (사용자 ID 권장).

## 아웃바운드 전달 대상

`openclaw message send` 또는 cron/웹훅에 다음 대상 형식을 사용합니다:

- `channel:<id>` 채널용
- `user:<id>` DM 용
- `@username` DM 용 (Mattermost API 를 통해 해결)

## 리액션 (message 도구)

- `channel=mattermost` 로 `message action=react` 를 사용합니다.
- `messageId` 는 Mattermost 게시물 ID 입니다.
- `emoji` 는 `thumbsup` 또는 `:+1:` 같은 이름을 허용합니다 (콜론은 선택).
- `remove=true` (불리언) 로 리액션을 제거합니다.

## 인터랙티브 버튼 (message 도구)

클릭 가능한 버튼이 있는 메시지를 보냅니다. 사용자가 버튼을 클릭하면 에이전트가 선택을 수신하고 응답할 수 있습니다.

채널 기능에 `inlineButtons` 를 추가하여 버튼을 활성화합니다:

```json5
{
  channels: {
    mattermost: {
      capabilities: ["inlineButtons"],
    },
  },
}
```

## 디렉토리 어댑터

Mattermost 플러그인에는 Mattermost API 를 통해 채널 및 사용자 이름을 해결하는 디렉토리 어댑터가 포함됩니다.

## 다중 계정

Mattermost 는 `channels.mattermost.accounts` 하위에서 여러 계정을 지원합니다.

## 문제 해결

- 채널에서 응답 없음: 봇이 채널에 있는지 확인하고 멘션합니다 (oncall), 트리거 접두사를 사용합니다 (onchar), 또는 `chatmode: "onmessage"` 를 설정합니다.
- 인증 오류: 봇 토큰, 기본 URL, 계정이 활성화되어 있는지 확인합니다.
- 다중 계정 문제: 환경 변수는 `default` 계정에만 적용됩니다.
- 버튼이 흰 상자로 표시됨: 에이전트가 잘못된 형식의 버튼 데이터를 보내고 있을 수 있습니다. 각 버튼에 `text` 와 `callback_data` 필드가 모두 있는지 확인합니다.
- 버튼이 렌더링되지만 클릭 시 아무 일도 없음: Mattermost 서버 구성에서 `AllowedUntrustedInternalConnections` 에 `127.0.0.1 localhost` 가 포함되고, `EnablePostActionIntegration` 이 `true` 인지 확인합니다.
