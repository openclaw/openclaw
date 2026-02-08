---
read_when:
    - WebChat 액세스 디버깅 또는 구성
summary: 채팅 UI에 대한 루프백 WebChat 정적 호스트 및 게이트웨이 WS 사용
title: 웹채팅
x-i18n:
    generated_at: "2026-02-08T16:12:32Z"
    model: gtx
    provider: google-translate
    source_hash: b5ee2b462c8c979ac27f80dea0cf12cf62b3c799cf8fd0a7721901e26efeb1a0
    source_path: web/webchat.md
    workflow: 15
---

# WebChat(게이트웨이 WebSocket UI)

상태: macOS/iOS SwiftUI 채팅 UI는 Gateway WebSocket과 직접 통신합니다.

## 그것은 무엇입니까

- 게이트웨이용 기본 채팅 UI(내장된 브라우저 및 로컬 정적 서버 없음)
- 다른 채널과 동일한 세션 및 라우팅 규칙을 사용합니다.
- 결정적 라우팅: 응답은 항상 WebChat으로 돌아갑니다.

## 빠른 시작

1. 게이트웨이를 시작하십시오.
2. WebChat UI(macOS/iOS 앱) 또는 Control UI 채팅 탭을 엽니다.
3. 게이트웨이 인증이 구성되어 있는지 확인하세요(루프백에서도 기본적으로 필요함).

## 작동 방식(행동)

- UI는 Gateway WebSocket에 연결하고 다음을 사용합니다. `chat.history`, `chat.send`, 그리고 `chat.inject`.
- `chat.inject` 기록에 직접 보조 메모를 추가하고 이를 UI에 브로드캐스트합니다(에이전트 실행 없음).
- 기록은 항상 게이트웨이에서 가져옵니다(로컬 파일 감시 없음).
- 게이트웨이에 연결할 수 없는 경우 WebChat은 읽기 전용입니다.

## 원격 사용

- 원격 모드는 SSH/Tailscale을 통해 게이트웨이 WebSocket을 터널링합니다.
- 별도의 WebChat 서버를 실행할 필요가 없습니다.

## 구성 참조(웹챗)

전체 구성: [구성](/gateway/configuration)

채널 옵션:

- 전용 없음 `webchat.*` 차단하다. WebChat은 아래의 게이트웨이 엔드포인트 + 인증 설정을 사용합니다.

관련 전역 옵션:

- `gateway.port`, `gateway.bind`: WebSocket 호스트/포트.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket 인증.
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: 원격 게이트웨이 대상.
- `session.*`: 세션 저장 및 기본 키 기본값입니다.
