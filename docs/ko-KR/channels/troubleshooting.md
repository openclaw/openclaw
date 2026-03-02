---
summary: "채널 수준의 빠른 문제 해결 (채널별 실패 서명 및 수정)"
read_when:
  - 채널 전송은 연결되었다고 하지만 회신 실패
  - 심층 공급자 문서 전에 채널 특정 확인이 필요함
title: "채널 문제 해결"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/troubleshooting.md
  workflow: 15
---

# 채널 문제 해결

채널이 연결되지만 동작이 잘못된 경우 이 페이지를 사용합니다.

## 명령 사다리

먼저 순서대로 실행합니다:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

건강한 기준선:

- `Runtime: running`
- `RPC probe: ok`
- 채널 프로브는 연결/준비 완료로 표시됨

## WhatsApp

### WhatsApp 실패 서명

| 증상                           | 가장 빠른 확인                             | 수정                                             |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------ |
| 연결되었지만 DM 회신 없음      | `openclaw pairing list whatsapp`           | 발신자 승인 또는 DM 정책/허용 목록 전환.         |
| 그룹 메시지 무시됨             | 구성에서 `requireMention` + 언급 패턴 확인 | 봇 mention 또는 해당 그룹에 대한 언급 정책 완화. |
| 무작위 disconnect/relogin 루프 | `openclaw channels status --probe` + 로그  | 다시 로그인하고 자격증명 디렉토리 정상 확인.     |

전체 문제 해결: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 실패 서명

| 증상                                       | 가장 빠른 확인                                 | 수정                                                                     |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `/start` 이지만 사용 가능한 회신 흐름 없음 | `openclaw pairing list telegram`               | 페어링 승인 또는 DM 정책 변경.                                           |
| 봇 온라인이지만 그룹 조용함                | mention 요구사항 및 봇 개인정보 보호 모드 확인 | 그룹 가시성을 위해 개인정보 보호 모드 비활성화 또는 봇 mention.          |
| 네트워크 오류로 실패 전송                  | 텔레그램 API 호출 실패를 위한 로그 검사        | `api.telegram.org` 로의 DNS/IPv6/프록시 라우팅 수정.                     |
| 업그레이드된 허용 목록이 차단              | `openclaw security audit` 및 구성 허용 목록    | `openclaw doctor --fix` 실행 또는 `@username` 을 숫자 발신자 ID 로 교체. |

전체 문제 해결: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Discord 실패 서명

| 증상                            | 가장 빠른 확인                         | 수정                                                     |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| 봇 온라인이지만 guild 회신 없음 | `openclaw channels status --probe`     | Guild/채널 허용 및 메시지 콘텐츠 의도 확인.              |
| 그룹 메시지 무시됨              | mention 게이팅 drops 에 대한 로그 확인 | 봇 mention 또는 guild/채널 `requireMention: false` 설정. |
| DM 회신 누락                    | `openclaw pairing list discord`        | DM 페어링 승인 또는 DM 정책 조정.                        |

전체 문제 해결: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Slack 실패 서명

| 증상                               | 가장 빠른 확인                       | 수정                                    |
| ---------------------------------- | ------------------------------------ | --------------------------------------- |
| Socket 모드 연결되었지만 응답 없음 | `openclaw channels status --probe`   | 앱 토큰 + 봇 토큰 및 필수 범위 확인.    |
| DM 차단됨                          | `openclaw pairing list slack`        | 페어링 승인 또는 DM 정책 완화.          |
| 채널 메시지 무시됨                 | `groupPolicy` 및 채널 허용 목록 확인 | 채널 허용 또는 정책을 `open` 으로 전환. |

전체 문제 해결: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 및 BlueBubbles

### iMessage 및 BlueBubbles 실패 서명

| 증상                                  | 가장 빠른 확인                                                            | 수정                                         |
| ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| 인바운드 이벤트 없음                  | webhook/서버 도달 가능성 및 앱 권한 확인                                  | webhook URL 또는 BlueBubbles 서버 상태 수정. |
| 전송할 수 있지만 macOS 에서 수신 없음 | 메시지 자동화에 대한 macOS 개인정보 보호 권한 확인                        | TCC 권한 재부여 및 채널 프로세스 재시작.     |
| DM 발신자 차단                        | `openclaw pairing list imessage` 또는 `openclaw pairing list bluebubbles` | 페어링 승인 또는 허용 목록 업데이트.         |

전체 문제 해결:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Signal 실패 서명

| 증상                             | 가장 빠른 확인                     | 수정                                            |
| -------------------------------- | ---------------------------------- | ----------------------------------------------- |
| Daemon 도달 가능하지만 봇 조용함 | `openclaw channels status --probe` | `signal-cli` daemon URL/계정 및 수신 모드 확인. |
| DM 차단됨                        | `openclaw pairing list signal`     | 발신자 승인 또는 DM 정책 조정.                  |
| 그룹 회신 트리거하지 않음        | 그룹 허용 목록 및 언급 패턴 확인   | 발신자/그룹 추가 또는 게이팅 완화.              |

전체 문제 해결: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Matrix 실패 서명

| 증상                          | 가장 빠른 확인                     | 수정                                    |
| ----------------------------- | ---------------------------------- | --------------------------------------- |
| 로그인했지만 방 메시지 무시됨 | `openclaw channels status --probe` | `groupPolicy` 및 방 허용 목록 확인.     |
| DM 처리하지 않음              | `openclaw pairing list matrix`     | 발신자 승인 또는 DM 정책 조정.          |
| 암호화된 방 실패              | 암호화 모듈 및 암호화 설정 확인    | 암호화 지원 활성화 및 방 재조인/동기화. |

전체 문제 해결: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
