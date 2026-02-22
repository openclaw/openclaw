---
summary: "Mattermost 봇 설정 및 OpenClaw 구성"
read_when:
  - Mattermost 설정하기
  - Mattermost 라우팅 디버깅
title: "Mattermost"
---

# Mattermost (plugin)

상태: 플러그인으로 지원 (봇 토큰 + WebSocket 이벤트). 채널, 그룹, 다이렉트 메시지가 지원됩니다.
Mattermost는 자체 호스팅 가능한 팀 메시징 플랫폼입니다. 제품 정보 및 다운로드는
[공식 사이트](https://mattermost.com)를 참조하세요.

## 플러그인 필요

Mattermost는 플러그인으로 제공되며 기본 설치에 포함되지 않습니다.

CLI 사용하여 설치 (npm registry):

```bash
openclaw plugins install @openclaw/mattermost
```

git 저장소에서 실행 중일 때 로컬 체크아웃:

```bash
openclaw plugins install ./extensions/mattermost
```

Mattermost를 설정/온보딩하는 동안 선택하고 git 체크아웃이 감지되면,
OpenClaw가 자동으로 로컬 설치 경로를 제공합니다.

자세한 내용: [플러그인](/ko-KR/tools/plugin)

## 빠른 설정

1. Mattermost 플러그인을 설치합니다.
2. Mattermost 봇 계정을 생성하고 **봇 토큰**을 복사합니다.
3. Mattermost **기본 URL**(예: `https://chat.example.com`)을 복사합니다.
4. OpenClaw를 구성하고 게이트웨이를 시작합니다.

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

## 환경 변수 (기본 계정)

환경 변수를 선호하는 경우, 게이트웨이 호스트에 설정:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

환경 변수는 **기본** 계정(`default`)에만 적용됩니다. 다른 계정은 설정 값을 사용해야 합니다.

## 채팅 모드

Mattermost는 다이렉트 메시지에 자동으로 응답합니다. 채널 동작은 `chatmode`로 제어됩니다:

- `oncall` (기본값): 채널에서 @언급될 때만 응답합니다.
- `onmessage`: 채널 메시지마다 응답합니다.
- `onchar`: 메시지가 트리거 접두어로 시작할 때 응답합니다.

설정 예시:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

참고:

- `onchar`도 명시적인 @언급에 응답합니다.
- `channels.mattermost.requireMention`은 기존 설정에 대해 적용되지만 `chatmode`가 선호됩니다.

## 액세스 제어 (다이렉트 메시지)

- 기본값: `channels.mattermost.dmPolicy = "pairing"` (알 수 없는 발신자가 페어링 코드를 받음).
- 승인 방법:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 공개 다이렉트 메시지: `channels.mattermost.dmPolicy="open"` 및 `channels.mattermost.allowFrom=["*"]`.

## 채널 (그룹)

- 기본값: `channels.mattermost.groupPolicy = "allowlist"` (언급 제한).
- `channels.mattermost.groupAllowFrom`(사용자 ID 또는 `@username`)을 통해 발신자를 허용 목록에 추가합니다.
- 공개 채널: `channels.mattermost.groupPolicy="open"` (언급 제한).

## 아웃바운드 전송용 대상

`openclaw message send` 또는 cron/webhooks와 함께 다음 대상 형식 사용:

- `channel:<id>` - 채널
- `user:<id>` - 다이렉트 메시지
- `@username` - 다이렉트 메시지 (Mattermost API를 통해 해석)

단순 ID는 채널로 간주됩니다.

## 반응 (메시지 도구)

- `message action=react`를 `channel=mattermost`와 함께 사용합니다.
- `messageId`는 Mattermost post id입니다.
- `emoji`는 `thumbsup` 또는 `:+1:`과 같은 이름을 허용합니다 (콜론은 선택 사항).
- 반응을 제거하려면 `remove=true` (boolean)를 설정합니다.
- 반응 추가/제거 이벤트는 라우팅된 에이전트 세션에 시스템 이벤트로 전달됩니다.

예시:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

설정:

- `channels.mattermost.actions.reactions`: 반응 동작 활성화/비활성화 (기본값 true).
- 계정별 재정의: `channels.mattermost.accounts.<id>.actions.reactions`.

## 멀티 계정

Mattermost는 `channels.mattermost.accounts`에서 여러 계정을 지원합니다:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 문제 해결

- 채널에서 응답 없음: 봇이 채널에 있는지 확인하고 언급 (`oncall`), 트리거 접두어 사용 (`onchar`), 또는 `chatmode: "onmessage"` 설정을 확인하십시오.
- 인증 오류: 봇 토큰, 기본 URL 및 계정 활성화 상태를 확인하십시오.
- 멀티 계정 문제: 환경 변수는 `default` 계정에만 적용됩니다.