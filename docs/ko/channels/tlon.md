---
read_when:
    - Tlon/Urbit 채널 기능 작업
summary: Tlon/Urbit 지원 상태, 기능 및 구성
title: 트론
x-i18n:
    generated_at: "2026-02-08T15:47:23Z"
    model: gtx
    provider: google-translate
    source_hash: 85fd29cda05b45637564acb0aafab44eb46ca8155a4b719a9d1a4f776cef6b2d
    source_path: channels/tlon.md
    workflow: 15
---

# Tlon(플러그인)

Tlon은 Urbit을 기반으로 구축된 탈중앙화 메신저입니다. OpenClaw는 Urbit 선박에 연결되어 다음 작업을 수행할 수 있습니다.
DM 및 그룹 채팅 메시지에 응답하세요. 그룹 답글에는 기본적으로 @ 멘션이 필요하며 다음과 같이 할 수 있습니다.
허용 목록을 통해 추가로 제한됩니다.

상태: 플러그인을 통해 지원됩니다. DM, 그룹 멘션, 스레드 답글, 텍스트 전용 미디어 대체
(캡션에 URL이 추가되었습니다). 반응, 설문 조사 및 기본 미디어 업로드는 지원되지 않습니다.

## 플러그인 필요

Tlon은 플러그인으로 제공되며 핵심 설치와 함께 번들로 제공되지 않습니다.

CLI(npm 레지스트리)를 통해 설치:

```bash
openclaw plugins install @openclaw/tlon
```

로컬 체크아웃(git repo에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/tlon
```

세부: [플러그인](/tools/plugin)

## 설정

1. Tlon 플러그인을 설치합니다.
2. 선박 URL과 로그인 코드를 수집하세요.
3. 구성 `channels.tlon`.
4. 게이트웨이를 다시 시작하십시오.
5. 봇에게 DM을 보내거나 그룹 채널에서 언급하세요.

최소 구성(단일 계정):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## 그룹 채널

자동 검색은 기본적으로 활성화되어 있습니다. 채널을 수동으로 고정할 수도 있습니다.

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

자동 검색을 비활성화합니다.

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## 접근 통제

DM 허용 목록(비어 있음 = 모두 허용):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

그룹 승인(기본적으로 제한됨):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## 전달 대상(CLI/cron)

다음과 함께 사용하세요 `openclaw message send` 또는 크론 전달:

- DM: `~sampel-palnet` 또는 `dm/~sampel-palnet`
- 그룹: `chat/~host-ship/channel` 또는 `group:~host-ship/channel`

## 메모

- 그룹 답글에는 멘션이 필요합니다(예: `~your-bot-ship`) 응답합니다.
- 스레드 응답: 인바운드 메시지가 스레드에 있는 경우 OpenClaw는 스레드 내에서 응답합니다.
- 메디아: `sendMedia` 텍스트 + URL로 대체됩니다(기본 업로드 없음).
