---
summary: "Fast channel level troubleshooting with per channel failure signatures and fixes"
read_when:
  - Channel transport says connected but replies fail
  - You need channel specific checks before deep provider docs
title: "Channel Troubleshooting"
x-i18n:
  source_hash: 30443f9aa52c4e0c732b12b18f69665349aaee45175c5d203fa4633cb216f5e0
---

# 채널 문제 해결

채널이 연결되었지만 동작이 잘못된 경우 이 페이지를 사용하세요.

## 명령 사다리

먼저 다음을 순서대로 실행하세요.

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

정상 기준:

- `Runtime: running`
- `RPC probe: ok`
- 채널 프로브에 연결/준비가 표시됩니다.

## 왓츠앱

### WhatsApp 실패 서명

| 증상                            | 가장 빠른 확인                             | 수정                                                      |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| 연결되었지만 DM 답장이 없습니다 | `openclaw pairing list whatsapp`           | 발신자를 승인하거나 DM 정책/허용 목록을 전환하세요.       |
| 그룹 메시지가 무시됨            | `requireMention` 확인 + 구성에서 패턴 언급 | 해당 그룹에 대한 봇을 언급하거나 언급 정책을 완화하세요.  |
| 무작위 연결 해제/재로그인 루프  | `openclaw channels status --probe` + 로그  | 다시 로그인하고 자격 증명 디렉터리가 정상인지 확인하세요. |

전체 문제 해결: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## 텔레그램

### 텔레그램 실패 서명

| 증상                                             | 가장 빠른 확인                                | 수정                                                                |
| ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------- |
| `/start` 하지만 사용 가능한 응답 흐름이 없습니다 | `openclaw pairing list telegram`              | 페어링을 승인하거나 DM 정책을 변경하세요.                           |
| 봇은 온라인이지만 그룹은 침묵을 유지합니다       | 언급 요구 사항 및 봇 개인 정보 보호 모드 확인 | 그룹 공개 또는 멘션 봇에 대한 개인 정보 보호 모드를 비활성화합니다. |
| 네트워크 오류로 인해 전송 실패                   | Telegram API 호출 실패 로그 검사              | DNS/IPv6/프록시 라우팅을 `api.telegram.org`로 수정합니다.           |

전체 문제 해결: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## 불화

### Discord 실패 서명

| 증상                                   | 가장 빠른 확인                     | 수정                                                            |
| -------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| 봇은 온라인이지만 길드 응답이 없습니다 | `openclaw channels status --probe` | 길드/채널을 허용하고 메시지 내용 의도를 확인합니다.             |
| 그룹 메시지가 무시됨                   | 멘션 게이팅 삭제에 대한 로그 확인  | 봇을 언급하거나 길드/채널 `requireMention: false`을 설정하세요. |
| DM 답글이 누락되었습니다               | `openclaw pairing list discord`    | DM 페어링을 승인하거나 DM 정책을 조정하세요.                    |

전체 문제 해결: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## 슬랙

### Slack 실패 서명

| 증상                                     | 가장 빠른 확인                       | 수정                                         |
| ---------------------------------------- | ------------------------------------ | -------------------------------------------- |
| 소켓 모드가 연결되었지만 응답이 없습니다 | `openclaw channels status --probe`   | 앱 토큰 + 봇 토큰 및 필수 범위를 확인하세요. |
| DM이 차단되었습니다                      | `openclaw pairing list slack`        | 페어링을 승인하거나 DM 정책을 완화하세요.    |
| 채널 메시지가 무시됨                     | `groupPolicy` 및 채널 허용 목록 확인 | 채널 또는 스위치 정책을 `open`로 허용합니다. |

전체 문제 해결: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage 및 BlueBubbles

### iMessage 및 BlueBubbles 오류 서명

| 증상                                          | 가장 빠른 확인                                                            | 수정                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| 인바운드 이벤트 없음                          | 웹훅/서버 연결 가능성 및 앱 권한 확인                                     | 웹훅 URL 또는 BlueBubbles 서버 상태를 수정하세요.         |
| macOS에서 보낼 수는 있지만 받을 수는 없습니다 | 메시지 자동화에 대한 macOS 개인 정보 보호 권한 확인                       | TCC 권한을 다시 부여하고 채널 프로세스를 다시 시작하세요. |
| DM 발신자가 차단되었습니다                    | `openclaw pairing list imessage` 또는 `openclaw pairing list bluebubbles` | 페어링을 승인하거나 허용 목록을 업데이트하세요.           |

전체 문제 해결:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#문제 해결](/channels/bluebubbles#troubleshooting)

## 시그널

### 신호 오류 서명

| 증상                                | 가장 빠른 확인                     | 수정                                                  |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| 데몬에 연결할 수 있지만 봇은 조용함 | `openclaw channels status --probe` | `signal-cli` 데몬 URL/계정 및 수신 모드를 확인하세요. |
| DM 차단됨                           | `openclaw pairing list signal`     | 발신자를 승인하거나 DM 정책을 조정하세요.             |
| 그룹 답글이 실행되지 않음           | 그룹 허용 목록 및 멘션 패턴 확인   | 발신자/그룹을 추가하거나 게이팅을 느슨하게 하세요.    |

전체 문제 해결: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## 매트릭스

### 매트릭스 실패 서명

| 증상                                    | 가장 빠른 확인                     | 수정                                                  |
| --------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| 로그인했지만 회의실 메시지를 무시합니다 | `openclaw channels status --probe` | `groupPolicy` 및 회의실 허용 목록을 확인하세요.       |
| DM은 처리되지 않습니다                  | `openclaw pairing list matrix`     | 발신자를 승인하거나 DM 정책을 조정하세요.             |
| 암호화된 방 실패                        | 암호화 모듈 및 암호화 설정 확인    | 암호화 지원을 활성화하고 룸에 다시 참여/동기화합니다. |

전체 문제 해결: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
