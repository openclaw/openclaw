---
summary: "브리지 프로토콜(레거시 노드): TCP JSONL, 페어링, 범위 지정 RPC"
read_when:
  - 노드 클라이언트 구축 또는 디버깅(iOS/Android/macOS 노드 모드)
  - 페어링 또는 브리지 인증 실패 조사
  - 게이트웨이에서 노드 표면 감시
title: "브리지 프로토콜"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/bridge-protocol.md
  workflow: 15
---

# 브리지 프로토콜(레거시 노드 전송)

브리지 프로토콜은 **레거시** 노드 전송(TCP JSONL)입니다. 새 노드 클라이언트는 통합 Gateway WebSocket 프로토콜을 대신 사용해야 합니다.

운영자 또는 노드 클라이언트를 구축하는 경우 [Gateway protocol](/gateway/protocol)을 사용하세요.

**참고:** 현재 OpenClaw 빌드는 더 이상 TCP 브리지 리스너를 제공하지 않습니다. 이 문서는 역사적 참고용으로 유지됩니다.
레거시 `bridge.*` 설정 키는 더 이상 설정 스키마의 일부가 아닙니다.

## 둘 다 있는 이유

- **보안 경계**: 브리지는 전체 게이트웨이 API 표면 대신 작은 허용 목록을 노출합니다.
- **페어링 + 노드 식별**: 노드 승인은 게이트웨이가 소유하며 노드별 토큰에 연결됩니다.
- **검색 UX**: 노드는 LAN에서 Bonjour를 통해 게이트웨이를 검색하거나 tailnet을 통해 직접 연결할 수 있습니다.
- **루프백 WS**: 전체 WS 제어 평면은 SSH를 통해 터널링되지 않는 한 로컬로 유지됩니다.

## 전송

- TCP, 한 줄당 하나의 JSON 객체(JSONL).
- 선택적 TLS(`bridge.tls.enabled`가 true인 경우).
- 레거시 기본 리스너 포트는 `18790`이었습니다(현재 빌드는 TCP 브리지를 시작하지 않음).

TLS가 활성화되면 검색 TXT 레코드는 `bridgeTls=1` 및 `bridgeTlsSha256`을 비시크릿 힌트로 포함합니다. Bonjour/mDNS TXT 레코드는 인증되지 않습니다. 클라이언트는 광고된 지문을 명시적인 사용자 의도 또는 기타 대역 외 검증 없이 권위 있는 핀으로 취급해서는 안 됩니다.

## 핸드셰이크 + 페어링

1. 클라이언트는 노드 메타데이터 + 토큰(이미 페어링된 경우)과 함께 `hello`를 전송합니다.
2. 페어링되지 않은 경우 게이트웨이가 `error` (`NOT_PAIRED`/`UNAUTHORIZED`)로 응답합니다.
3. 클라이언트가 `pair-request`를 전송합니다.
4. 게이트웨이는 승인을 기다린 다음 `pair-ok` 및 `hello-ok`를 전송합니다.

`hello-ok`는 `serverName`을 반환하며 `canvasHostUrl`을 포함할 수 있습니다.

## 프레임

클라이언트 → 게이트웨이:

- `req` / `res`: 범위 지정 게이트웨이 RPC(채팅, 세션, 설정, 상태, voicewake, skills.bins)
- `event`: 노드 신호(음성 대본, 에이전트 요청, 채팅 구독, exec 수명 주기)

게이트웨이 → 클라이언트:

- `invoke` / `invoke-res`: 노드 명령(`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`)
- `event`: 구독한 세션의 채팅 업데이트
- `ping` / `pong`: keepalive

레거시 허용 목록 적용은 `src/gateway/server-bridge.ts`에 있었습니다(제거됨).

## Exec 수명 주기 이벤트

노드는 `exec.finished` 또는 `exec.denied` 이벤트를 발생시켜 system.run 활동을 표시할 수 있습니다.
이는 게이트웨이의 시스템 이벤트에 매핑됩니다. (레거시 노드는 여전히 `exec.started`를 발생시킬 수 있습니다.)

페이로드 필드(명시되지 않으면 모두 선택사항):

- `sessionKey` (필수): 시스템 이벤트를 수신할 에이전트 세션.
- `runId`: 그룹화를 위한 고유한 exec id.
- `command`: 원본 또는 형식이 지정된 명령 문자열.
- `exitCode`, `timedOut`, `success`, `output`: 완료 세부 정보(완료된 경우만).
- `reason`: 거부 이유(거부된 경우만).

## Tailnet 사용

- 브리지를 tailnet IP에 바인딩: `~/.openclaw/openclaw.json`에서 `bridge.bind: "tailnet"`.
- 클라이언트는 MagicDNS 이름 또는 tailnet IP를 통해 연결합니다.
- Bonjour는 **네트워크를 넘지 못함**; 필요할 때 수동 호스트/포트 또는 광역 DNS‑SD를 사용하세요.

## 버전 관리

브리지는 현재 **암시적 v1**(최소/최대 협상 없음). 이전 호환성이 예상됩니다. 획기적인 변경 전에 브리지 프로토콜 버전 필드를 추가하세요.
