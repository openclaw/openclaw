---
summary: "브리지 프로토콜 (레거시 노드): TCP JSONL, 페어링, 범위 지정 RPC"
read_when:
  - 노드 클라이언트 빌드 또는 디버깅 시 (iOS/Android/macOS 노드 모드)
  - 페어링 또는 브리지 인증 실패 조사 시
  - 게이트웨이가 노출하는 노드 표면 감사 시
title: "브리지 프로토콜"
---

# 브리지 프로토콜 (레거시 노드 전송)

브리지 프로토콜은 **레거시** 노드 전송 방식입니다 (TCP JSONL). 새로운 노드 클라이언트는 통합된 게이트웨이 WebSocket 프로토콜을 사용해야 합니다.

운영자 또는 노드 클라이언트를 구축하는 경우 [게이트웨이 프로토콜](/ko-KR/gateway/protocol)을 사용하십시오.

**참고:** 현재 OpenClaw 빌드에서는 TCP 브리지 리스너가 더 이상 포함되지 않습니다. 이 문서는 역사적 참고용으로 유지됩니다.
레거시 `bridge.*` 설정 키는 더 이상 설정 스키마의 일부가 아닙니다.

## 두 가지 프로토콜이 존재하는 이유

- **보안 경계**: 브리지는 전체 게이트웨이 API 표면 대신 소규모 허용 목록을 노출합니다.
- **페어링 + 노드 신원**: 노드 입장은 게이트웨이가 소유하며 노드별 토큰에 연결됩니다.
- **검색 UX**: 노드는 LAN에서 Bonjour를 통해 게이트웨이를 검색하거나, tailnet을 통해 직접 연결할 수 있습니다.
- **루프백 WS**: 전체 WS 제어 평면은 SSH로 터널링되지 않는 한 로컬에 유지됩니다.

## 전송 방식

- TCP, 한 줄에 하나의 JSON 객체 (JSONL).
- 선택적 TLS (`bridge.tls.enabled`가 true인 경우).
- 레거시 기본 리스너 포트는 `18790`이었습니다 (현재 빌드에서는 TCP 브리지를 시작하지 않습니다).

TLS가 활성화된 경우, 검색 TXT 레코드에 `bridgeTls=1`과 `bridgeTlsSha256`이 비밀이 아닌 힌트로 포함됩니다. Bonjour/mDNS TXT 레코드는 인증되지 않습니다. 명시적인 사용자 의도나 대역 외 검증 없이 클라이언트가 광고된 지문을 권위 있는 핀으로 취급해서는 안 됩니다.

## 핸드셰이크 + 페어링

1. 클라이언트는 노드 메타데이터 + 토큰 (이미 페어링된 경우)과 함께 `hello`를 전송합니다.
2. 페어링되지 않은 경우, 게이트웨이는 `error` (`NOT_PAIRED`/`UNAUTHORIZED`)로 응답합니다.
3. 클라이언트가 `pair-request`를 전송합니다.
4. 게이트웨이는 승인을 기다린 후 `pair-ok`와 `hello-ok`를 전송합니다.

`hello-ok`는 `serverName`을 반환하며 `canvasHostUrl`이 포함될 수 있습니다.

## 프레임

클라이언트 → 게이트웨이:

- `req` / `res`: 범위 지정 게이트웨이 RPC (채팅, 세션, 설정, 상태, voicewake, skills.bins)
- `event`: 노드 신호 (음성 전사, 에이전트 요청, 채팅 구독, exec 수명 주기)

게이트웨이 → 클라이언트:

- `invoke` / `invoke-res`: 노드 명령 (`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`)
- `event`: 구독된 세션의 채팅 업데이트
- `ping` / `pong`: 연결 유지

레거시 허용 목록 적용은 `src/gateway/server-bridge.ts`에 있었습니다 (제거됨).

## Exec 수명 주기 이벤트

노드는 `exec.finished` 또는 `exec.denied` 이벤트를 발생시켜 system.run 활동을 표시할 수 있습니다.
이는 게이트웨이의 시스템 이벤트로 매핑됩니다. (레거시 노드는 여전히 `exec.started`를 발생시킬 수 있습니다.)

페이로드 필드 (별도 언급이 없으면 모두 선택 사항):

- `sessionKey` (필수): 시스템 이벤트를 수신할 에이전트 세션.
- `runId`: 그룹화를 위한 고유 exec ID.
- `command`: 원시 또는 형식화된 명령 문자열.
- `exitCode`, `timedOut`, `success`, `output`: 완료 세부 정보 (finished 전용).
- `reason`: 거부 이유 (denied 전용).

## Tailnet 사용

- `~/.openclaw/openclaw.json`에서 브리지를 tailnet IP에 바인딩: `bridge.bind: "tailnet"`.
- 클라이언트는 MagicDNS 이름 또는 tailnet IP를 통해 연결합니다.
- Bonjour는 **네트워크를 넘지 않습니다**. 필요한 경우 수동 호스트/포트 또는 광역 DNS-SD를 사용하십시오.

## 버전 관리

브리지는 현재 **암묵적 v1**입니다 (최소/최대 협상 없음). 하위 호환성이 기대됩니다. 호환성을 깨는 변경 전에 브리지 프로토콜 버전 필드를 추가하십시오.
