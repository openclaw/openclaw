---
summary: "Tlon/Urbit 지원 상태, 기능, 및 설정"
read_when:
  - Tlon/Urbit 채널 기능 작업 중
title: "Tlon"
---

# Tlon (플러그인)

Tlon은 Urbit에 기반한 탈중앙화 메신저입니다. OpenClaw는 Urbit 함선에 연결되어 다이렉트 메시지와 그룹 채팅 메시지에 응답할 수 있습니다. 그룹 응답은 기본적으로 @ 언급이 필요하며 허용 목록을 통해 추가로 제한될 수 있습니다.

상태: 플러그인을 통해 지원됩니다. 다이렉트 메시지, 그룹 언급, 스레드 응답 및 텍스트 전용 미디어 폴백 (캡션에 URL 첨부). 반응, 설문 조사 및 네이티브 미디어 업로드는 지원되지 않습니다.

## 플러그인 필요

Tlon은 플러그인으로 제공되며 핵심 설치에 포함되지 않습니다.

CLI를 통한 설치 (npm 레지스트리):

```bash
openclaw plugins install @openclaw/tlon
```

로컬 체크아웃 (git repo에서 실행할 때):

```bash
openclaw plugins install ./extensions/tlon
```

자세한 내용: [플러그인](/ko-KR/tools/plugin)

## 설정

1. Tlon 플러그인을 설치합니다.
2. 함선 URL과 로그인 코드를 수집합니다.
3. `channels.tlon`을 설정합니다.
4. 게이트웨이를 다시 시작합니다.
5. 봇에게 다이렉트 메시지를 보내거나 그룹 채널에서 언급합니다.

최소 설정 (단일 계정):

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

개인/LAN 함선 URL (고급):

기본적으로 OpenClaw는 이 플러그인에 대해 사설/내부 호스트명 및 IP 범위를 차단합니다 (SSRF 강화). 사설 네트워크에 함선 URL이 있는 경우 (예: `http://192.168.1.50:8080` 또는 `http://localhost:8080`), 명시적으로 허용해야 합니다:

```json5
{
  channels: {
    tlon: {
      allowPrivateNetwork: true,
    },
  },
}
```

## 그룹 채널

자동 검색은 기본적으로 활성화되어 있습니다. 채널을 수동으로 고정할 수도 있습니다:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

자동 검색 비활성화:

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

다이렉트 메시지 허용 목록 (비어있음 = 모두 허용):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

그룹 승인 (기본적으로 제한됨):

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

이 도구를 `openclaw message send` 또는 cron 전달과 함께 사용하세요:

- 다이렉트 메시지: `~sampel-palnet` 또는 `dm/~sampel-palnet`
- 그룹: `chat/~host-ship/channel` 또는 `group:~host-ship/channel`

## 주의사항

- 그룹 응답은 응답을 위해 언급이 필요합니다 (예: `~your-bot-ship`).
- 스레드 응답: 들어오는 메시지가 스레드에 있는 경우, OpenClaw는 스레드에서 응답합니다.
- 미디어: `sendMedia`는 텍스트 + URL로 폴백됩니다 (네이티브 업로드 없음).