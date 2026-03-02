---
summary: "Loopback WebChat 정적 호스트 및 채팅 UI용 Gateway WS 사용"
read_when:
  - WebChat 액세스를 디버깅하거나 구성할 때
title: "WebChat"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: web/webchat.md
workflow: 15
---

# WebChat(Gateway WebSocket UI)

상태: macOS/iOS SwiftUI 채팅 UI가 Gateway WebSocket과 직접 이야기합니다.

## 무엇인가

- Gateway용 네이티브 채팅 UI(포함 브라우저 없음 및 로컬 정적 서버 없음).
- 다른 채널과 동일한 세션 및 라우팅 규칙을 사용합니다.
- 결정론적 라우팅: 회신은 항상 WebChat으로 돌아갑니다.

## 빠른 시작

1. Gateway를 시작합니다.
2. WebChat UI(macOS/iOS 앱) 또는 Control UI 채팅 탭을 엽니다.
3. Gateway 인증이 구성되어 있는지 확인합니다(loopback에서도 기본값으로 필요).

## 작동 방식(동작)

- UI는 Gateway WebSocket에 연결하고 `chat.history`, `chat.send` 및 `chat.inject`를 사용합니다.
- `chat.history`는 안정성을 위해 제한됩니다: Gateway는 긴 텍스트 필드를 자를 수 있고, 무거운 메타데이터를 생략하고, 과도한 항목을 `[chat.history omitted: message too large]`로 바꿀 수 있습니다.
- `chat.inject`는 어시스턴트 메모를 트랜스크립트에 직접 추가하고 UI에 브로드캐스트합니다(에이전트 실행 없음).
- 중단된 실행은 부분 어시스턴트 출력을 UI에 표시된 상태로 유지할 수 있습니다.
- Gateway는 버퍼된 출력이 존재할 때 중단된 부분 어시스턴트 텍스트를 트랜스크립트 히스토리에 유지하고 중단 메타데이터로 해당 항목을 표시합니다.
- 히스토리는 항상 Gateway에서 가져옵니다(로컬 파일 모니터링 없음).
- Gateway에 도달할 수 없으면 WebChat은 읽기 전용입니다.

## Control UI 에이전트 도구 패널

- Control UI `/agents` Tools 패널은 `tools.catalog`를 통해 런타임 카탈로그를 가져오고 각
  도구를 `core` 또는 `plugin:<id`(플러그인 도구는 `optional`로도)로 표시합니다.
- `tools.catalog`를 사용할 수 없으면 패널은 내장 정적 목록으로 폴백합니다.
- 패널은 프로필 및 오버라이드 구성을 편집하지만 유효 런타임 액세스는 여전히 정책
  우선순위(`allow`/`deny`, 에이전트별 및 제공자/채널 오버라이드)를 따릅니다.

## 원격 사용

- 원격 모드는 Gateway WebSocket을 SSH/Tailscale을 통해 터널합니다.
- 별도의 WebChat 서버를 실행할 필요가 없습니다.

## 구성 참조(WebChat)

전체 구성: [구성](/gateway/configuration)

채널 옵션:

- 전용 `webchat.*` 블록이 없습니다. WebChat은 아래의 Gateway 엔드포인트 + 인증 설정을 사용합니다.

관련 전역 옵션:

- `gateway.port`, `gateway.bind`: WebSocket 호스트/포트.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket 인증(토큰/암호).
- `gateway.auth.mode: "trusted-proxy"`: 브라우저 클라이언트용 역 프록시 인증([신뢰 프록시 인증](/gateway/trusted-proxy-auth) 참고).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: 원격 Gateway 대상.
- `session.*`: 세션 저장 및 주 키 기본값.
