---
summary: "채널별 실패 시그니처와 해결 방법을 통해 빠르게 수행하는 채널 수준 문제 해결"
read_when:
  - 채널 전송은 연결됨으로 표시되지만 응답이 실패할 때
  - 프로바이더 문서를 깊이 보기 전에 채널별 점검이 필요할 때
title: "채널 문제 해결"
---

# 채널 문제 해결

채널은 연결되지만 동작이 올바르지 않을 때 이 페이지를 사용하십시오.

## 명령 단계

먼저 다음을 순서대로 실행하십시오:

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
- 채널 프로브에서 연결됨/준비됨으로 표시됨

## WhatsApp

### WhatsApp 실패 시그니처

| 증상                    | 가장 빠른 확인                                   | 수정                                                    |
| --------------------- | ------------------------------------------ | ----------------------------------------------------- |
| 연결되었지만 다이렉트 메시지 응답 없음 | `openclaw pairing list whatsapp`           | 발신자를 승인하거나 다이렉트 메시지 정책/허용 목록을 전환하십시오. |
| 그룹 메시지가 무시됨           | `requireMention` + 설정의 멘션 패턴 확인            | 봇을 멘션하거나 해당 그룹의 멘션 정책을 완화하십시오.        |
| 무작위 연결 끊김/재로그인 반복     | `openclaw channels status --probe` + 로그 확인 | 다시 로그인하고 자격 증명 디렉토리가 정상인지 확인하십시오.     |

전체 문제 해결: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 실패 시그니처

| 증상                           | 가장 빠른 확인                         | 수정                                                              |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `/start` 이지만 사용 가능한 응답 흐름 없음 | `openclaw pairing list telegram` | 페어링을 승인하거나 다이렉트 메시지 정책을 변경하십시오.                 |
| 봇은 온라인이지만 그룹이 조용함            | 멘션 요구 사항과 봇 프라이버시 모드 확인          | 그룹 가시성을 위해 프라이버시 모드를 비활성화하거나 봇을 멘션하십시오.         |
| 네트워크 오류와 함께 전송 실패            | Telegram API 호출 실패에 대한 로그 점검     | `api.telegram.org` 로의 DNS/IPv6/프록시 라우팅을 수정하십시오. |

전체 문제 해결: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 실패 시그니처

| 증상                 | 가장 빠른 확인                           | 수정                                                               |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------- |
| 봇은 온라인이지만 길드 응답 없음 | `openclaw channels status --probe` | 길드/채널을 허용하고 메시지 콘텐츠 인텐트를 확인하십시오.                 |
| 그룹 메시지가 무시됨        | 멘션 게이팅 드롭에 대한 로그 확인                | 봇을 멘션하거나 길드/채널 `requireMention: false` 을 설정하십시오. |
| DM 응답 누락           | `openclaw pairing list discord`    | 다이렉트 메시지 페어링을 승인하거나 다이렉트 메시지 정책을 조정하십시오.         |

전체 문제 해결: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 실패 시그니처

| 증상                  | 가장 빠른 확인                           | 수정                                              |
| ------------------- | ---------------------------------- | ----------------------------------------------- |
| 소켓 모드는 연결되었지만 응답 없음 | `openclaw channels status --probe` | 앱 토큰 + 봇 토큰 및 필수 스코프를 확인하십시오.   |
| 다이렉트 메시지 차단됨        | `openclaw pairing list slack`      | 페어링을 승인하거나 다이렉트 메시지 정책을 완화하십시오. |
| 채널 메시지가 무시됨         | `groupPolicy` 및 채널 허용 목록 확인        | 채널을 허용하거나 정책을 `open` 로 전환하십시오.  |

전체 문제 해결: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 및 BlueBubbles

### iMessage 및 BlueBubbles 실패 시그니처

| 증상                      | 가장 빠른 확인                                                                | 수정                                                   |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| 인바운드 이벤트 없음             | 웹훅/서버 도달 가능성 및 앱 권한 확인                                                  | 웹훅 URL 또는 BlueBubbles 서버 상태를 수정하십시오. |
| macOS 에서 송신 가능하지만 수신 불가 | Messages 자동화에 대한 macOS 개인정보 보호 권한 확인                                    | TCC 권한을 다시 부여하고 채널 프로세스를 재시작하십시오.    |
| 다이렉트 메시지 발신자 차단됨        | `openclaw pairing list imessage` 또는 `openclaw pairing list bluebubbles` | 페어링을 승인하거나 허용 목록을 업데이트하십시오.          |

전체 문제 해결:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal 실패 시그니처

| 증상                     | 가장 빠른 확인                           | 수정                                                      |
| ---------------------- | ---------------------------------- | ------------------------------------------------------- |
| 데몬에는 연결되었지만 봇이 응답하지 않음 | `openclaw channels status --probe` | `signal-cli` 데몬 URL/계정 및 수신 모드를 확인하십시오. |
| 다이렉트 메시지 차단됨           | `openclaw pairing list signal`     | 발신자를 승인하거나 다이렉트 메시지 정책을 조정하십시오.         |
| 그룹 응답이 트리거되지 않음        | 그룹 허용 목록 및 멘션 패턴 확인                | 발신자/그룹을 추가하거나 게이팅을 완화하십시오.              |

전체 문제 해결: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix 실패 시그니처

| 증상                 | 가장 빠른 확인                           | 수정                                               |
| ------------------ | ---------------------------------- | ------------------------------------------------ |
| 로그인되었지만 룸 메시지를 무시함 | `openclaw channels status --probe` | `groupPolicy` 및 룸 허용 목록을 확인하십시오. |
| DM이 처리되지 않음        | `openclaw pairing list matrix`     | 발신자를 승인하거나 다이렉트 메시지 정책을 조정하십시오.  |
| 암호화된 룸 실패          | 암호화 모듈 및 암호화 설정 확인                 | 암호화 지원을 활성화하고 룸에 재참여/동기화하십시오.    |

전체 문제 해결: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
