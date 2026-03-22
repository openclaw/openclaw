---
summary: "브릿지 프로토콜 (레거시 노드): TCP JSONL, 페어링, 범위 제한 RPC"
read_when:
  - 노드 클라이언트를 빌드하거나 디버깅할 때 (iOS/Android/macOS 노드 모드)
  - 페어링 또는 브릿지 인증 실패를 조사할 때
  - Gateway가 노출하는 노드 표면을 감사할 때
title: "브릿지 프로토콜"
x-i18n:
  source_path: docs/gateway/bridge-protocol.md
---

# 브릿지 프로토콜 (레거시 노드 전송)

브릿지 프로토콜은 **레거시** 노드 전송 (TCP JSONL)입니다. 새 노드 클라이언트는 통합 Gateway WebSocket 프로토콜을 대신 사용해야 합니다.

운영자 또는 노드 클라이언트를 빌드하는 경우, [Gateway 프로토콜](/gateway/protocol)을 사용하세요.

**참고:** 현재 OpenClaw 빌드는 더 이상 TCP 브릿지 리스너를 제공하지 않습니다. 이 문서는 역사적 참고를 위해 유지됩니다.
레거시 `bridge.*` 설정 키는 더 이상 설정 스키마에 포함되지 않습니다.

## 두 가지가 있는 이유

- **보안 경계**: 브릿지는 전체 Gateway API 표면 대신 작은 허용 목록을 노출합니다.
- **페어링 + 노드 ID**: 노드 승인은 Gateway가 소유하며 노드별 토큰에 연결됩니다.
- **디스커버리 UX**: 노드는 LAN에서 Bonjour를 통해 Gateway를 발견하거나, tailnet을 통해 직접 연결할 수 있습니다.
- **루프백 WS**: 전체 WS 컨트롤 플레인은 SSH로 터널링하지 않는 한 로컬에 유지됩니다.

## 전송

- TCP, 한 줄당 하나의 JSON 객체 (JSONL).
- 선택적 TLS (`bridge.tls.enabled`가 true일 때).
- 레거시 기본 리스너 포트는 `18790`이었습니다 (현재 빌드는 TCP 브릿지를 시작하지 않음).

TLS가 활성화되면 디스커버리 TXT 레코드에 `bridgeTls=1`과 비밀이 아닌 힌트로 `bridgeTlsSha256`이 포함됩니다. Bonjour/mDNS TXT 레코드는 인증되지 않으므로, 클라이언트는 명시적 사용자 의도나 다른 대역 외 검증 없이 광고된 지문을 권위 있는 핀으로 취급해서는 안 됩니다.

## 핸드셰이크 + 페어링

1. 클라이언트가 노드 메타데이터 + 토큰(이미 페어링된 경우)과 함께 `hello`를 보냅니다.
2. 페어링되지 않은 경우, Gateway가 `error` (`NOT_PAIRED`/`UNAUTHORIZED`)로 응답합니다.
3. 클라이언트가 `pair-request`를 보냅니다.
4. Gateway가 승인을 기다린 다음 `pair-ok`와 `hello-ok`를 보냅니다.

`hello-ok`는 `serverName`을 반환하며 `canvasHostUrl`을 포함할 수 있습니다.

## 프레임

클라이언트 → Gateway:

- `req` / `res`: 범위 제한 Gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: 노드 시그널 (음성 전사, 에이전트 요청, 채팅 구독, exec 수명주기)

Gateway → 클라이언트:

- `invoke` / `invoke-res`: 노드 명령 (`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`)
- `event`: 구독된 세션의 채팅 업데이트
- `ping` / `pong`: 킵얼라이브

레거시 허용 목록 강제는 `src/gateway/server-bridge.ts`에 있었습니다 (제거됨).

## 실행 수명주기 이벤트

노드는 `exec.finished` 또는 `exec.denied` 이벤트를 발생시켜 system.run 활동을 표면에 나타낼 수 있습니다.
이들은 Gateway에서 시스템 이벤트에 매핑됩니다. (레거시 노드는 여전히 `exec.started`를 발생시킬 수 있습니다.)

페이로드 필드 (명시되지 않으면 모두 선택 사항):

- `sessionKey` (필수): 시스템 이벤트를 수신할 에이전트 세션.
- `runId`: 그룹화를 위한 고유 exec ID.
- `command`: 원시 또는 포맷된 명령 문자열.
- `exitCode`, `timedOut`, `success`, `output`: 완료 세부사항 (finished만).
- `reason`: 거부 이유 (denied만).

## Tailnet 사용

- 브릿지를 tailnet IP에 바인드: `~/.openclaw/openclaw.json`에서 `bridge.bind: "tailnet"`.
- 클라이언트는 MagicDNS 이름 또는 tailnet IP를 통해 연결합니다.
- Bonjour는 네트워크를 **넘지 않습니다**. 필요한 경우 수동 호스트/포트 또는 광역 DNS-SD를 사용하세요.

## 버전 관리

브릿지는 현재 **암묵적 v1** (min/max 협상 없음)입니다. 하위 호환성이 예상되며, 호환되지 않는 변경 전에 브릿지 프로토콜 버전 필드를 추가하세요.
