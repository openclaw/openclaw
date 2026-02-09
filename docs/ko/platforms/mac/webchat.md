---
summary: "mac 앱이 Gateway(게이트웨이) WebChat 을 임베드하는 방식과 이를 디버그하는 방법"
read_when:
  - mac WebChat 뷰 또는 loopback 포트를 디버깅할 때
title: "WebChat"
---

# WebChat (macOS 앱)

macOS 메뉴 막대 앱은 WebChat UI 를 네이티브 SwiftUI 뷰로 임베드합니다. 이는 Gateway(게이트웨이)에 연결되며, 선택된 에이전트에 대해 기본적으로 **메인 세션**을 사용합니다 (다른 세션을 위한 세션 전환기도 제공됩니다).

- **로컬 모드**: 로컬 Gateway(게이트웨이) WebSocket 에 직접 연결합니다.
- **원격 모드**: SSH 를 통해 Gateway(게이트웨이) 제어 포트를 포워딩하고, 해당 터널을 데이터 플레인으로 사용합니다.

## 실행 및 디버깅

- 수동: Lobster 메뉴 → “Open Chat”.

- 테스트용 자동 열기:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 로그: `./scripts/clawlog.sh` (서브시스템 `bot.molt`, 카테고리 `WebChatSwiftUI`).

## 38. 연결 방식

- 데이터 플레인: Gateway(게이트웨이) WS 메서드 `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` 및 이벤트 `chat`, `agent`, `presence`, `tick`, `health`.
- 세션: 기본적으로 기본 세션(`main`, 범위가 전역일 경우 `global`)을 사용합니다. UI 에서 세션 간 전환이 가능합니다.
- 온보딩은 첫 실행 설정을 분리하기 위해 전용 세션을 사용합니다.

## 보안 표면

- 원격 모드는 SSH 를 통해 Gateway(게이트웨이) WebSocket 제어 포트만 포워딩합니다.

## 알려진 제한 사항

- UI 는 채팅 세션에 최적화되어 있으며 (완전한 브라우저 샌드박스는 아닙니다).
