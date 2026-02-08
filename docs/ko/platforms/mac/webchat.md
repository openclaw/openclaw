---
read_when:
    - Mac WebChat 보기 또는 루프백 포트 디버깅
summary: Mac 앱에 게이트웨이 WebChat을 포함하는 방법 및 이를 디버깅하는 방법
title: 웹채팅
x-i18n:
    generated_at: "2026-02-08T16:08:34Z"
    model: gtx
    provider: google-translate
    source_hash: 7c425374673b817ada8961a564e254d8d1b6eb522f843d855483fe430c27dfac
    source_path: platforms/mac/webchat.md
    workflow: 15
---

# 웹챗(macOS 앱)

macOS 메뉴 표시줄 앱은 WebChat UI를 기본 SwiftUI 보기로 포함합니다. 그것
게이트웨이에 연결하고 기본값은 **메인 세션** 선택한 사람을 위해
에이전트(다른 세션을 위한 세션 전환기 포함)

- **로컬 모드**: 로컬 게이트웨이 WebSocket에 직접 연결합니다.
- **원격 모드**: SSH를 통해 게이트웨이 제어 포트를 전달하고 이를 사용합니다.
  터널을 데이터 플레인으로 사용합니다.

## 실행 및 디버깅

- 매뉴얼: 랍스터 메뉴 → “오픈채팅”.
- 테스트를 위해 자동 열기:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 로그: `./scripts/clawlog.sh` (하위 시스템 `bot.molt`, 범주 `WebChatSwiftUI`).

## 연결 방법

- 데이터 플레인: 게이트웨이 WS 메서드 `chat.history`, `chat.send`, `chat.abort`, 
  `chat.inject` 그리고 이벤트 `chat`, `agent`, `presence`, `tick`, `health`.
- 세션: 기본 세션은 기본 세션(`main`, 또는 `global` 범위가 다음과 같은 경우
  글로벌). UI는 세션 간에 전환할 수 있습니다.
- 온보딩에서는 전용 세션을 사용하여 최초 실행 설정을 별도로 유지합니다.

## 보안 표면

- 원격 모드는 SSH를 통해 Gateway WebSocket 제어 포트만 전달합니다.

## 알려진 제한사항

- UI는 채팅 세션(전체 브라우저 샌드박스 아님)에 최적화되어 있습니다.
