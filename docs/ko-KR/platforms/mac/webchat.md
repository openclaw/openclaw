---
summary: "Mac 앱이 Gateway WebChat 을 내장하는 방법 및 디버그 방법"
read_when:
  - Mac WebChat 뷰 또는 루프백 포트를 디버깅할 때
title: "WebChat (macOS)"
x-i18n:
  source_path: docs/platforms/mac/webchat.md
---

# WebChat (macOS 앱)

macOS 메뉴 바 앱은 WebChat UI 를 네이티브 SwiftUI 뷰로 내장합니다. Gateway 에
연결하고 선택된 에이전트의 **main 세션** 을 기본값으로 합니다 (다른 세션을 위한
세션 전환기 포함).

- **로컬 모드**: 로컬 Gateway WebSocket 에 직접 연결합니다.
- **원격 모드**: SSH 를 통해 Gateway 제어 포트를 포워딩하고 해당
  터널을 데이터 플레인으로 사용합니다.

## 실행 및 디버깅

- 수동: Lobster 메뉴 → "채팅 열기".
- 테스트용 자동 열기:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 로그: `./scripts/clawlog.sh` (서브시스템 `ai.openclaw`, 카테고리 `WebChatSwiftUI`).

## 연결 구조

- 데이터 플레인: Gateway WS 메서드 `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` 및 이벤트 `chat`, `agent`, `presence`, `tick`, `health`.
- 세션: 기본 세션 (`main`, 또는 범위가 전역일 때 `global`) 을 기본값으로 합니다. UI 에서 세션 간 전환이 가능합니다.
- 온보딩은 초기 설정을 분리하기 위해 전용 세션을 사용합니다.

## 보안 영역

- 원격 모드는 SSH 를 통해 Gateway WebSocket 제어 포트만 포워딩합니다.

## 알려진 제한 사항

- UI 는 채팅 세션에 최적화되어 있습니다 (완전한 브라우저 샌드박스가 아닙니다).
