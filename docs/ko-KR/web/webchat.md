---
summary: "Loopback WebChat static host and Gateway WS usage for chat UI"
read_when:
  - WebChat 액세스를 디버깅하거나 구성할 때
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

상태: macOS/iOS SwiftUI 채팅 UI 는 게이트웨이 WebSocket 과 직접 통신합니다.

## 무엇인가

- 게이트웨이를 위한 네이티브 채팅 UI (내장된 브라우저나 로컬 정적 서버가 없음).
- 다른 채널과 동일한 세션 및 라우팅 규칙을 사용합니다.
- 결정적 라우팅: 응답은 항상 WebChat 으로 돌아옵니다.

## 빠른 시작

1. 게이트웨이를 시작합니다.
2. WebChat UI (macOS/iOS 앱) 또는 Control UI 채팅 탭을 엽니다.
3. 게이트웨이 인증이 구성되었는지 확인합니다 (로컬 루프백의 경우에도 기본적으로 필요).

## 작동 방법 (동작)

- UI 는 게이트웨이 WebSocket 에 연결되고 `chat.history`, `chat.send`, 및 `chat.inject` 를 사용합니다.
- `chat.history` 는 안정성을 위해 경계를 설정합니다: 게이트웨이는 긴 텍스트 필드를 잘라내고, 무거운 메타데이터를 생략하며, 너무 큰 항목을 `[chat.history 생략됨: 메시지가 너무 큼]` 으로 대체할 수 있습니다.
- `chat.inject` 는 보조 메모를 기록에 직접 추가하고 이를 UI 에 브로드캐스트합니다 (에이전트 실행 없음).
- 중단된 실행도 UI 에서 부분적으로 보조 출력을 표시할 수 있습니다.
- 게이트웨이는 버퍼링된 출력이 있는 경우 중단된 부분 보조 텍스트를 기록 이력에 남기며, 이러한 항목에 중단 메타데이터를 표시합니다.
- 이력은 항상 게이트웨이에서 가져옵니다 (로컬 파일 감시 없음).
- 게이트웨이가 접근할 수 없으면 WebChat 은 읽기 전용입니다.

## 원격 사용

- 원격 모드는 SSH/Tailscale 을 통해 게이트웨이 WebSocket 을 터널링합니다.
- 별도의 WebChat 서버를 실행할 필요가 없습니다.

## 구성 참조 (WebChat)

전체 구성: [Configuration](/ko-KR/gateway/configuration)

채널 옵션:

- 전용 `webchat.*` 블록이 없습니다. WebChat 은 다음의 게이트웨이 엔드포인트 + 인증 설정을 사용합니다.

관련 글로벌 옵션:

- `gateway.port`, `gateway.bind`: WebSocket 호스트/포트.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket 인증 (토큰/비밀번호).
- `gateway.auth.mode: "trusted-proxy"`: 브라우저 클라이언트를 위한 역 프록시 인증 (자세한 내용은 [Trusted Proxy Auth](/ko-KR/gateway/trusted-proxy-auth) 참조).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: 원격 게이트웨이 대상.
- `session.*`: 세션 저장소 및 주요 키 기본값.