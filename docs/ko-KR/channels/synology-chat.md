---
summary: "Synology Chat 웹훅 설정 및 OpenClaw 구성"
read_when:
  - OpenClaw 와 Synology Chat 을 설정하는 경우
  - Synology Chat 웹훅 라우팅을 디버깅하는 경우
title: "Synology Chat"
x-i18n:
  source_path: docs/channels/synology-chat.md
---

# Synology Chat (플러그인)

상태: Synology Chat 웹훅을 사용한 다이렉트 메시지 채널로 플러그인을 통해 지원됩니다.
플러그인은 Synology Chat 발신 웹훅에서 인바운드 메시지를 수신하고 Synology Chat 수신 웹훅을 통해 응답을 보냅니다.

## 플러그인 필요

Synology Chat 은 플러그인 기반이며 기본 코어 채널 설치에 포함되지 않습니다.

로컬 checkout 에서 설치:

```bash
openclaw plugins install ./extensions/synology-chat
```

자세한 내용: [Plugins](/tools/plugin)

## 빠른 설정

1. Synology Chat 플러그인을 설치하고 활성화합니다.
   - `openclaw onboard` 에서 이제 `openclaw channels add` 와 동일한 채널 설정 목록에 Synology Chat 이 표시됩니다.
   - 비대화형 설정: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
2. Synology Chat 통합에서:
   - 수신 웹훅을 만들고 URL 을 복사합니다.
   - 시크릿 토큰으로 발신 웹훅을 만듭니다.
3. 발신 웹훅 URL 을 OpenClaw Gateway 로 지정합니다:
   - 기본적으로 `https://gateway-host/webhook/synology`.
   - 또는 사용자 정의 `channels.synology-chat.webhookPath`.
4. OpenClaw 에서 설정을 완료합니다.
   - 안내: `openclaw onboard`
   - 직접: `openclaw channels add --channel synology-chat --token <token> --url <incoming-webhook-url>`
5. Gateway 를 재시작하고 Synology Chat 봇에 DM 을 보냅니다.

최소 구성:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "synology-outgoing-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...",
      webhookPath: "/webhook/synology",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
      rateLimitPerMinute: 30,
      allowInsecureSsl: false,
    },
  },
}
```

## 환경 변수

기본 계정의 경우 환경 변수를 사용할 수 있습니다:

- `SYNOLOGY_CHAT_TOKEN`
- `SYNOLOGY_CHAT_INCOMING_URL`
- `SYNOLOGY_NAS_HOST`
- `SYNOLOGY_ALLOWED_USER_IDS` (쉼표로 구분)
- `SYNOLOGY_RATE_LIMIT`
- `OPENCLAW_BOT_NAME`

구성 값이 환경 변수보다 우선합니다.

## DM 정책 및 접근 제어

- `dmPolicy: "allowlist"` 가 권장 기본값입니다.
- `allowedUserIds` 는 Synology 사용자 ID 목록 (또는 쉼표로 구분된 문자열) 을 허용합니다.
- `allowlist` 모드에서 빈 `allowedUserIds` 목록은 잘못된 구성으로 처리되며 웹훅 라우트가 시작되지 않습니다 (모두 허용하려면 `dmPolicy: "open"` 을 사용하세요).
- `dmPolicy: "open"` 은 모든 발신자를 허용합니다.
- `dmPolicy: "disabled"` 는 DM 을 차단합니다.
- 페어링 승인 작동:
  - `openclaw pairing list synology-chat`
  - `openclaw pairing approve synology-chat <CODE>`

## 아웃바운드 전달

숫자 Synology Chat 사용자 ID 를 대상으로 사용합니다.

예시:

```bash
openclaw message send --channel synology-chat --target 123456 --text "Hello from OpenClaw"
openclaw message send --channel synology-chat --target synology-chat:123456 --text "Hello again"
```

URL 기반 파일 전달을 통해 미디어 전송이 지원됩니다.

## 다중 계정

`channels.synology-chat.accounts` 하위에서 여러 Synology Chat 계정이 지원됩니다.
각 계정은 토큰, 수신 URL, 웹훅 경로, DM 정책, 제한을 재정의할 수 있습니다.

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "token-a",
          incomingUrl: "https://nas-a.example.com/...token=...",
        },
        alerts: {
          token: "token-b",
          incomingUrl: "https://nas-b.example.com/...token=...",
          webhookPath: "/webhook/synology-alerts",
          dmPolicy: "allowlist",
          allowedUserIds: ["987654"],
        },
      },
    },
  },
}
```

## 보안 참고 사항

- `token` 을 비밀로 유지하고 유출된 경우 교체하세요.
- 자체 서명된 로컬 NAS 인증서를 명시적으로 신뢰하지 않는 한 `allowInsecureSsl: false` 를 유지하세요.
- 인바운드 웹훅 요청은 토큰으로 검증되고 발신자별로 속도 제한됩니다.
- 프로덕션에서는 `dmPolicy: "allowlist"` 를 권장합니다.
