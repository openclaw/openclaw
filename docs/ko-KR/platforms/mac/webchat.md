---
summary: "mac 앱이 gateway WebChat을 어떻게 임베드하고 디버그하는 방식"
read_when:
  - mac WebChat 보기 또는 loopback 포트를 디버깅할 때
title: "WebChat"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/webchat.md"
  workflow: 15
---

# WebChat (macOS 앱)

macOS 메뉴 바 앱은 WebChat UI를 기본 SwiftUI 보기로 임베드합니다. 이것은
Gateway에 연결하고 선택한 에이전트의 **main 세션**으로 기본값을 설정합니다 (다른 세션에 대한 세션 전환기 포함).

- **로컬 모드**: 로컬 Gateway WebSocket에 직접 연결합니다.
- **원격 모드**: Gateway 제어 포트를 SSH를 통해 포워드하고 해당
  터널을 데이터 플레인으로 사용합니다.

## 시작 & 디버깅

- 수동: Lobster 메뉴 → "Open Chat".
- 테스트용 자동 열기:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- 로그: `./scripts/clawlog.sh` (subsystem `ai.openclaw`, category `WebChatSwiftUI`).

## 와이어링 방식

- 데이터 플레인: Gateway WS 메서드 `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` 및 이벤트 `chat`, `agent`, `presence`, `tick`, `health`.
- 세션: 주 세션으로 기본값 (`main`, 또는 scope이
  global일 때 `global`). UI는 세션 간에 전환할 수 있습니다.
- 온보딩은 첫 실행 설정을 별도로 유지하기 위해 dedicated 세션을 사용합니다.

## 보안 표면

- 원격 모드는 SSH를 통해 Gateway WebSocket 제어 포트만 포워드합니다.

## 알려진 제한 사항

- UI는 chat 세션에 최적화되어 있습니다 (전체 브라우저 샌드박스가 아님).
