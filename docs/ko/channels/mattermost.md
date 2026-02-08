---
read_when:
    - Mattermost 설정
    - Mattermost 라우팅 디버깅
summary: Mattermost 봇 설정 및 OpenClaw 구성
title: 가장 중요한
x-i18n:
    generated_at: "2026-02-08T15:47:07Z"
    model: gtx
    provider: google-translate
    source_hash: 1599abf7539c51f74ecb95afeba6f969ba3c519d36f944bd1d0b94e74bc80520
    source_path: channels/mattermost.md
    workflow: 15
---

# Mattermost(플러그인)

상태: 플러그인을 통해 지원됩니다(봇 토큰 + WebSocket 이벤트). 채널, 그룹, DM이 지원됩니다.
Mattermost는 자체 호스팅 가능한 팀 메시징 플랫폼입니다. 공식 사이트를 참조하세요
[Mattost.com](https://mattermost.com) 제품 세부정보 및 다운로드를 확인하세요.

## 플러그인 필요

Mattermost는 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

CLI(npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/mattermost
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/mattermost
```

구성/온보딩 중에 Mattermost를 선택하고 git 체크아웃이 감지되면,
OpenClaw는 로컬 설치 경로를 자동으로 제공합니다.

세부: [플러그인](/tools/plugin)

## 빠른 설정

1. Mattermost 플러그인을 설치합니다.
2. Mattermost 봇 계정을 생성하고 **봇 토큰**.
3. 가장 중요한 것을 복사하세요 **기본 URL** (예: `https://chat.example.com`).
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

## 환경 변수(기본 계정)

환경 변수를 선호하는 경우 게이트웨이 호스트에서 다음을 설정하십시오.

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

환경 변수는 다음에만 적용됩니다. **기본** 계정 (`default`). 다른 계정은 구성 값을 사용해야 합니다.

## 채팅 모드

Mattermost는 DM에 자동으로 응답합니다. 채널 동작은 다음에 의해 제어됩니다. `chatmode`:

- `oncall` (기본값): 채널에서 @멘션된 경우에만 응답합니다.
- `onmessage`: 모든 채널 메시지에 응답합니다.
- `onchar`: 메시지가 트리거 접두사로 시작될 때 응답합니다.

구성 예:

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

- `onchar` 명시적인 @멘션에는 여전히 응답합니다.
- `channels.mattermost.requireMention` 레거시 구성에 대해서는 존중되지만 `chatmode` 선호됩니다.

## 액세스 제어(DM)

- 기본: `channels.mattermost.dmPolicy = "pairing"` (알 수 없는 발신자는 페어링 코드를 받습니다.)
- 승인 방법:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 공개 DM: `channels.mattermost.dmPolicy="open"` ...을 더한 `channels.mattermost.allowFrom=["*"]`.

## 채널(그룹)

- 기본: `channels.mattermost.groupPolicy = "allowlist"` (언급 게이트).
- 허용 목록 발신자: `channels.mattermost.groupAllowFrom` (사용자 ID 또는 `@username`).
- 오픈 채널: `channels.mattermost.groupPolicy="open"` (언급 게이트).

## 아웃바운드 배송 대상

다음과 같은 대상 형식을 사용하세요. `openclaw message send` 또는 크론/웹훅:

- `channel:<id>` 채널의 경우
- `user:<id>` DM을 위해
- `@username` DM의 경우(Mattermost API를 통해 해결됨)

Bare ID는 채널로 처리됩니다.

## 다중 계정

Mattermost는 다음의 여러 계정을 지원합니다. `channels.mattermost.accounts`:

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

- 채널에 응답 없음: 봇이 채널에 있는지 확인하고 이를 언급(oncall)하거나 트리거 접두사(onchar)를 사용하거나 설정합니다. `chatmode: "onmessage"`.
- 인증 오류: 봇 토큰, 기본 URL, 계정 활성화 여부를 확인하세요.
- 다중 계정 문제: 환경 변수는 다음에만 적용됩니다. `default` 계정.
