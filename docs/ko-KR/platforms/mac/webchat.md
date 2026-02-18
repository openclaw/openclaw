---
summary: "mac 앱이 게이트웨이 WebChat 을 임베드하는 방법과 디버깅 방법"
read_when:
  - mac WebChat 뷰 또는 로컬 루프백 포트를 디버깅할 때
title: "WebChat"
---

# WebChat (macOS 앱)

macOS 메뉴 바 앱은 WebChat UI 를 네이티브 SwiftUI 뷰로 임베드합니다. 게이트웨이에 연결하고 선택된 에이전트의 **주 세션**을 기본값으로 설정하며, 다른 세션에 대한 세션 전환기를 제공합니다.

- **로컬 모드**: 로컬 게이트웨이 WebSocket 에 직접 연결합니다.
- **원격 모드**: SSH를 통해 게이트웨이 제어 포트를 전달하며, 해당 터널을 데이터 플레인으로 사용합니다.

## 실행 및 디버깅

- 수동: 랍스터 메뉴 → “Open Chat”.
- 테스트를 위한 자동 열기:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 로그: `./scripts/clawlog.sh` (서브시스템 `bot.molt`, 카테고리 `WebChatSwiftUI`).

## 연결 방법

- 데이터 플레인: 게이트웨이 WS 메서드 `chat.history`, `chat.send`, `chat.abort`, `chat.inject` 및 이벤트 `chat`, `agent`, `presence`, `tick`, `health`.
- 세션: 기본값은 주 세션 (`main`, 범위가 전역일 때는 `global`). UI 는 세션 간 전환이 가능합니다.
- 온보딩은 첫 실행 설정을 분리하기 위해 전용 세션을 사용합니다.

## 보안 지면

- 원격 모드는 SSH를 통해 게이트웨이 WebSocket 제어 포트만 전달합니다.

## 알려진 제한 사항

- UI 는 채팅 세션에 최적화되어 있으며 (완전한 브라우저 샌드박스가 아님)입니다.
