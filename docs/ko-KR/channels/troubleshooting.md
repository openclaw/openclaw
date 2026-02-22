---
summary: "채널 레벨별 장애 해결을 위한 빠른 서명 및 수정"
read_when:
  - 채널 전송이 연결되었지만 응답에 실패할 때
  - 심층 프로바이더 문서 이전에 채널별 검사가 필요할 때
title: "채널 문제 해결"
---

# 채널 문제 해결

채널이 연결되었으나 동작이 잘못될 때 이 페이지를 사용하세요.

## 명령어 순서

다음을 순서대로 실행하세요:

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
- 채널 프로브가 연결/준비 상태 표시

## WhatsApp

### WhatsApp 오류 서명

| 증상                          | 가장 빠른 확인 방법                            | 수정 방법                                                 |
| ----------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| 연결되었으나 다이렉트 메시지 응답 없음 | `openclaw pairing list whatsapp`             | 보낸 사람 승인 또는 다이렉트 메시지 정책/허용 목록 전환.   |
| 그룹 메시지 무시됨           | 스킬 설정에서 `requireMention` + 멘션 패턴 확인 | 봇을 멘션하거나 해당 그룹의 멘션 정책 완화.               |
| 무작위 연결 해제/재로그인 루프 | `openclaw channels status --probe` + 로그     | 다시 로그인하고 자격 증명 디렉터리가 건강한지 확인.        |

전체 문제 해결: [/channels/whatsapp#troubleshooting-quick](/ko-KR/channels/whatsapp#troubleshooting-quick)

## Telegram

### Telegram 오류 서명

| 증상                             | 가장 빠른 확인 방법                         | 수정 방법                                                                   |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `/start`하지만 유용한 응답 흐름 없음 | `openclaw pairing list telegram`            | 페어링 승인 또는 다이렉트 메시지 정책 변경.                                 |
| 봇 온라인이지만 그룹이 조용함     | 멘션 요구 사항 및 봇 프라이버시 모드 확인   | 그룹 가시성을 위해 프라이버시 모드 비활성화 또는 봇 멘션.                   |
| 네트워크 오류로 전송 실패      | Telegram API 호출 실패 로그 검토          | `api.telegram.org`에 대한 DNS/IPv6/프록시 라우팅 수정.                      |
| 업그레이드 후 허용 목록이 차단됨 | `openclaw security audit` 및 구성 허용 목록 | `openclaw doctor --fix` 실행 또는 `@username`을 숫자 발신자 ID로 교체.      |

전체 문제 해결: [/channels/telegram#troubleshooting](/ko-KR/channels/telegram#troubleshooting)

## Discord

### Discord 오류 서명

| 증상                           | 가장 빠른 확인 방법                       | 수정 방법                                                      |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| 봇 온라인이지만 길드 응답 없음 | `openclaw channels status --probe`       | 길드/채널 허용 및 메시지 콘텐츠 의도 확인.                     |
| 그룹 메시지 무시됨             | 로그에서 멘션 게이팅 드롭 확인           | 봇 멘션 또는 길드/채널 `requireMention: false` 설정.           |
| 다이렉트 메시지 응답 없음     | `openclaw pairing list discord`          | 다이렉트 메시지 페어링 승인 또는 다이렉트 메시지 정책 조정.     |

전체 문제 해결: [/channels/discord#troubleshooting](/ko-KR/channels/discord#troubleshooting)

## Slack

### Slack 오류 서명

| 증상                                    | 가장 빠른 확인 방법                       | 수정 방법                                               |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| 소켓 모드가 연결되었지만 응답 없음      | `openclaw channels status --probe`       | 앱 토큰 + 봇 토큰 및 필수 범위 확인.                    |
| 다이렉트 메시지 차단됨                  | `openclaw pairing list slack`            | 페어링 승인 또는 다이렉트 메시지 정책 완화.              |
| 채널 메시지 무시됨                       | `groupPolicy` 및 채널 허용 목록 확인     | 채널 허용 또는 정책을 `open`으로 전환.                  |

전체 문제 해결: [/channels/slack#troubleshooting](/ko-KR/channels/slack#troubleshooting)

## iMessage 및 BlueBubbles

### iMessage 및 BlueBubbles 오류 서명

| 증상                             | 가장 빠른 확인 방법                                      | 수정 방법                                             |
| -------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 인바운드 이벤트 없음            | 웹훅/서버 도달 가능성 및 앱 권한 확인                  | 웹훅 URL 또는 BlueBubbles 서버 상태 수정.               |
| macOS에서 보낼 수 있지만 수신 없음 | Messages 자동화를 위한 macOS 프라이버시 권한 확인      | TCC 권한을 다시 부여하고 채널 프로세스 재시작.        |
| 다이렉트 메시지 발신자 차단됨   | `openclaw pairing list imessage` 또는 `openclaw pairing list bluebubbles` | 페어링 승인 또는 허용 목록 업데이트.                   |

전체 문제 해결:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/ko-KR/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/ko-KR/channels/bluebubbles#troubleshooting)

## Signal

### Signal 오류 서명

| 증상                            | 가장 빠른 확인 방법                          | 수정 방법                                               |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| 데몬 접근 가능하지만 봇이 조용한 경우 | `openclaw channels status --probe`          | `signal-cli` 데몬 URL/계정 및 수신 모드 확인.           |
| 다이렉트 메시지 차단됨          | `openclaw pairing list signal`              | 발신자 승인 또는 다이렉트 메시지 정책 조정.              |
| 그룹 응답이 트리거되지 않음     | 그룹 허용 목록 및 멘션 패턴 확인            | 발신자/그룹 추가 또는 게이팅 완화.                      |

전체 문제 해결: [/channels/signal#troubleshooting](/ko-KR/channels/signal#troubleshooting)

## Matrix

### Matrix 오류 서명

| 증상                              | 가장 빠른 확인 방법                        | 수정 방법                              |
| -------------------------------- | ---------------------------------------- | ---------------------------------------- |
| 로그인 되었으나 룸 메시지 무시됨 | `openclaw channels status --probe`       | `groupPolicy` 및 룸 허용 목록 확인.     |
| 다이렉트 메시지 처리되지 않음     | `openclaw pairing list matrix`           | 발신자 승인 또는 다이렉트 메시지 정책 조정. |
| 암호화된 룸 실패                  | 암호화 모듈 및 설정 확인                  | 암호화 지원 활성화 및 재가입/동기화 룸.  |

전체 문제 해결: [/channels/matrix#troubleshooting](/ko-KR/channels/matrix#troubleshooting)