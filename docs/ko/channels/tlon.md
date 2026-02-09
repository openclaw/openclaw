---
summary: "Tlon/Urbit 지원 상태, 기능 및 구성"
read_when:
  - Tlon/Urbit 채널 기능을 작업할 때
title: "Tlon"
---

# Tlon (플러그인)

Tlon 은 Urbit 기반의 탈중앙화 메신저입니다. OpenClaw 는 사용자의 Urbit ship 에 연결되어 다이렉트 메시지와 그룹 채팅 메시지에 응답할 수 있습니다. 그룹 응답은 기본적으로 @ 멘션이 필요하며, allowlist 를 통해 추가로 제한할 수 있습니다.

상태: 플러그인을 통해 지원됩니다. 다이렉트 메시지, 그룹 멘션, 스레드 답글, 텍스트 전용 미디어 폴백(캡션에 URL 추가)을 지원합니다. 반응, 투표, 네이티브 미디어 업로드는 지원되지 않습니다.

## 플러그인 필요

Tlon 은 플러그인으로 제공되며 코어 설치에 포함되어 있지 않습니다.

CLI 로 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/tlon
```

로컬 체크아웃 (git 리포지토리에서 실행하는 경우):

```bash
openclaw plugins install ./extensions/tlon
```

자세한 내용은 다음을 참고하십시오: [Plugins](/tools/plugin)

## 설정

1. Tlon 플러그인을 설치합니다.
2. ship URL 과 로그인 코드를 준비합니다.
3. `channels.tlon` 을(를) 구성합니다.
4. Gateway(게이트웨이) 를 재시작합니다.
5. 봇에게 DM을 보내거나 그룹 채널에서 멘션하세요.

최소 구성 (단일 계정):

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

자동 디바이스 검색은 기본적으로 활성화되어 있습니다. 채널을 수동으로 고정할 수도 있습니다:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

자동 디바이스 검색 비활성화:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## 접근 제어

다이렉트 메시지 allowlist (비어 있음 = 모두 허용):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

그룹 권한 부여 (기본적으로 제한됨):

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

## 전달 대상 (CLI/cron)

`openclaw message send` 또는 cron 전달과 함께 사용하십시오:

- 다이렉트 메시지: `~sampel-palnet` 또는 `dm/~sampel-palnet`
- 그룹: `chat/~host-ship/channel` 또는 `group:~host-ship/channel`

## 참고

- 그룹 응답에는 응답을 위해 멘션(예: `~your-bot-ship`) 이 필요합니다.
- 스레드 답글: 수신 메시지가 스레드에 있는 경우 OpenClaw 는 스레드 내로 답장합니다.
- 미디어: `sendMedia` 는 텍스트 + URL 로 폴백됩니다(네이티브 업로드 없음).
