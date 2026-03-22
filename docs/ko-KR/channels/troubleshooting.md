---
summary: "채널별 장애 징후와 수정 방법을 포함한 빠른 채널 수준 문제 해결"
read_when:
  - 채널 전송이 연결되었다고 표시되지만 응답이 실패하는 경우
  - 심층 프로바이더 문서 전에 채널별 점검이 필요한 경우
title: "채널 문제 해결"
x-i18n:
  source_path: docs/channels/troubleshooting.md
---

# 채널 문제 해결

채널이 연결되었지만 동작이 올바르지 않을 때 이 페이지를 사용하세요.

## 명령 순서

먼저 이 순서로 실행하세요:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

정상 기준선:

- `Runtime: running`
- `RPC probe: ok`
- 채널 프로브가 connected/ready 표시

## WhatsApp

### WhatsApp 장애 징후

| 증상                           | 가장 빠른 점검                             | 수정                                                   |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| 연결되었지만 DM 응답 없음      | `openclaw pairing list whatsapp`           | 발신자를 승인하거나 DM 정책/허용 목록을 변경합니다.    |
| 그룹 메시지 무시됨             | 구성에서 `requireMention` + 멘션 패턴 확인 | 봇을 멘션하거나 해당 그룹의 멘션 정책을 완화합니다.    |
| 무작위 연결 해제/재로그인 반복 | `openclaw channels status --probe` + 로그  | 재로그인하고 자격 증명 디렉토리가 정상인지 확인합니다. |

전체 문제 해결: [/channels/whatsapp#troubleshooting](/channels/whatsapp#troubleshooting)

## Telegram

### Telegram 장애 징후

| 증상                                       | 가장 빠른 점검                              | 수정                                                                               |
| ------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/start` 하지만 사용 가능한 응답 흐름 없음 | `openclaw pairing list telegram`            | 페어링을 승인하거나 DM 정책을 변경합니다.                                          |
| 봇은 온라인이지만 그룹이 조용함            | 멘션 요구 사항 및 봇 프라이버시 모드 확인   | 그룹 가시성을 위해 프라이버시 모드를 비활성화하거나 봇을 멘션합니다.               |
| 네트워크 오류와 함께 전송 실패             | Telegram API 호출 실패 로그 검사            | `api.telegram.org` 로의 DNS/IPv6/프록시 라우팅을 수정합니다.                       |
| 시작 시 `setMyCommands` 거부               | `BOT_COMMANDS_TOO_MUCH` 로그 검사           | 플러그인/스킬/사용자 정의 Telegram 명령을 줄이거나 네이티브 메뉴를 비활성화합니다. |
| 업그레이드 후 허용 목록이 차단함           | `openclaw security audit` 및 구성 허용 목록 | `openclaw doctor --fix` 를 실행하거나 `@username` 을 숫자 발신자 ID 로 교체합니다. |

전체 문제 해결: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 장애 징후

| 증상                             | 가장 빠른 점검                     | 수정                                                             |
| -------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| 봇은 온라인이지만 길드 응답 없음 | `openclaw channels status --probe` | 길드/채널을 허용하고 메시지 콘텐츠 인텐트를 확인합니다.          |
| 그룹 메시지 무시됨               | 멘션 게이팅 드롭 로그 확인         | 봇을 멘션하거나 길드/채널 `requireMention: false` 를 설정합니다. |
| DM 응답 누락                     | `openclaw pairing list discord`    | DM 페어링을 승인하거나 DM 정책을 조정합니다.                     |

전체 문제 해결: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 장애 징후

| 증상                               | 가장 빠른 점검                       | 수정                                             |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------ |
| Socket 모드 연결되었지만 응답 없음 | `openclaw channels status --probe`   | 앱 토큰 + 봇 토큰 및 필수 스코프를 확인합니다.   |
| DM 차단됨                          | `openclaw pairing list slack`        | 페어링을 승인하거나 DM 정책을 완화합니다.        |
| 채널 메시지 무시됨                 | `groupPolicy` 및 채널 허용 목록 확인 | 채널을 허용하거나 정책을 `open` 으로 전환합니다. |

전체 문제 해결: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 및 BlueBubbles

### iMessage 및 BlueBubbles 장애 징후

| 증상                                 | 가장 빠른 점검                                                            | 수정                                                |
| ------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| 인바운드 이벤트 없음                 | 웹훅/서버 도달 가능성 및 앱 권한 확인                                     | 웹훅 URL 또는 BlueBubbles 서버 상태를 수정합니다.   |
| macOS 에서 전송 가능하지만 수신 불가 | Messages 자동화에 대한 macOS 개인 정보 권한 확인                          | TCC 권한을 재부여하고 채널 프로세스를 재시작합니다. |
| DM 발신자 차단됨                     | `openclaw pairing list imessage` 또는 `openclaw pairing list bluebubbles` | 페어링을 승인하거나 허용 목록을 업데이트합니다.     |

전체 문제 해결:

- [/channels/imessage#troubleshooting](/channels/imessage#troubleshooting)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal 장애 징후

| 증상                         | 가장 빠른 점검                     | 수정                                                  |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------- |
| 데몬 도달 가능하지만 봇 조용 | `openclaw channels status --probe` | `signal-cli` 데몬 URL/계정 및 수신 모드를 확인합니다. |
| DM 차단됨                    | `openclaw pairing list signal`     | 발신자를 승인하거나 DM 정책을 조정합니다.             |
| 그룹 응답이 트리거되지 않음  | 그룹 허용 목록 및 멘션 패턴 확인   | 발신자/그룹을 추가하거나 게이팅을 완화합니다.         |

전체 문제 해결: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix 장애 징후

| 증상                          | 가장 빠른 점검                     | 수정                                               |
| ----------------------------- | ---------------------------------- | -------------------------------------------------- |
| 로그인되었지만 룸 메시지 무시 | `openclaw channels status --probe` | `groupPolicy` 및 룸 허용 목록을 확인합니다.        |
| DM 이 처리되지 않음           | `openclaw pairing list matrix`     | 발신자를 승인하거나 DM 정책을 조정합니다.          |
| 암호화된 룸 실패              | 암호화 모듈 및 암호화 설정 확인    | 암호화 지원을 활성화하고 룸을 재가입/동기화합니다. |

전체 문제 해결: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
