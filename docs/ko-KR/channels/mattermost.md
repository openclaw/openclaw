---
summary: "Mattermost 봇 설정 및 OpenClaw 설정"
read_when:
  - Mattermost 설정 중
  - Mattermost 라우팅 디버깅 중
title: "Mattermost"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/channels/mattermost.md"
  workflow: 15
---

# Mattermost (플러그인)

상태: 플러그인을 통해 지원됨 (봇 토큰 + WebSocket 이벤트). 채널, 그룹, DM이 지원됩니다.
Mattermost는 자체 호스팅 가능한 팀 메시징 플랫폼입니다; [mattermost.com](https://mattermost.com)의 공식 사이트에서 제품 세부 정보 및 다운로드를 참조하세요.

## 플러그인 필요

Mattermost는 플러그인으로 제공되며 핵심 설치에 번들되지 않습니다.

CLI (npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/mattermost
```

로컬 체크아웃 (git repo에서 실행 중):

```bash
openclaw plugins install ./extensions/mattermost
```

설정/온보딩 중 Mattermost를 선택하고 git 체크아웃이 감지되면 OpenClaw가 자동으로 로컬 설치 경로를 제안합니다.

세부 정보: [플러그인](/tools/plugin)

## 빠른 설정

1. Mattermost 플러그인 설치.
2. Mattermost 봇 계정을 만들고 **봇 토큰** 복사.
3. Mattermost **기본 URL** 복사 (예: `https://chat.example.com`).
4. OpenClaw 설정 및 게이트웨이 시작.

최소 설정:

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

게이트웨이 호스트에서 환경 변수를 선호하면 다음을 설정합니다:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

환경 변수는 **기본** 계정 (`default`)에만 적용됩니다. 다른 계정은 설정 값을 사용해야 합니다.

## 채팅 모드

Mattermost는 DM에 자동 응답합니다. 채널 동작은 `chatmode`로 제어됩니다:

- `oncall` (기본값): 채널에서 @멘션되었을 때만 응답.
- `onmessage`: 모든 채널 메시지에 응답.
- `onchar`: 메시지가 트리거 접두사로 시작할 때 응답.

설정 예:

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

- `onchar`은 여전히 명시적 @멘션에 응답합니다.
- `channels.mattermost.requireMention`은 레거시 설정에 대해 존중되지만 `chatmode`가 선호됩니다.

## 접근 제어 (DM)

- 기본값: `channels.mattermost.dmPolicy = "pairing"` (알 수 없는 발신자가 페어링 코드를 받음).
- 승인:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 공개 DM: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## 채널 (그룹)

- 기본값: `channels.mattermost.groupPolicy = "allowlist"` (멘션 게이트).
- `channels.mattermost.groupAllowFrom`으로 발신자 허용 목록 (사용자 ID 권장).
- `@username` 매칭은 변경 가능하며 `channels.mattermost.dangerouslyAllowNameMatching: true`일 때만 활성화됨.
- 열린 채널: `channels.mattermost.groupPolicy="open"` (멘션 게이트).
- 런타임 참고: `channels.mattermost`가 완전히 누락되면 런타임은 그룹 확인에 대해 `groupPolicy="allowlist"`로 폴백합니다 (`channels.defaults.groupPolicy`가 설정되어 있어도).

## 아웃바운드 배송용 대상

`openclaw message send` 또는 cron/웹훅과 함께 사용할 대상 형식:

- `channel:<id>` for a 채널
- `user:<id>` for a DM
- `@username` for a DM (Mattermost API를 통해 해결)

맨 ID는 채널로 취급됩니다.

## 반응 (메시지 도구)

- `message action=react` with `channel=mattermost` 사용.
- `messageId`는 Mattermost 게시물 ID입니다.
- `emoji`는 `thumbsup` 또는 `:+1:` 같은 이름을 허용합니다 (콜론은 선택사항).
- `remove=true` (부울) 설정하여 반응을 제거합니다.
- 반응 추가/제거 이벤트는 시스템 이벤트로 라우팅된 에이전트 세션에 전달됩니다.

예:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

설정:

- `channels.mattermost.actions.reactions`: 반응 액션 활성화/비활성화 (기본값 true).
- 계정별 재정의: `channels.mattermost.accounts.<id>.actions.reactions`.

## 다중 계정

Mattermost는 `channels.mattermost.accounts` 아래의 다중 계정을 지원합니다:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "기본", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "알림", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 문제 해결

- 채널에서 회신 없음: 봇이 채널에 있는지, @멘션하는지 (oncall), 트리거 접두사 (onchar) 사용 또는 `chatmode: "onmessage"` 설정 확인.
- 인증 오류: 봇 토큰, 기본 URL, 계정이 활성화되었는지 확인.
- 다중 계정 문제: 환경 변수는 `default` 계정에만 적용됩니다.
