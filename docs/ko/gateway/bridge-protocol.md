---
summary: "브리지 프로토콜 (레거시 노드): TCP JSONL, 페어링, 범위 지정 RPC"
read_when:
  - 노드 클라이언트 (iOS/Android/macOS 노드 모드)를 구축하거나 디버깅할 때
  - 페어링 또는 브리지 인증 실패를 조사할 때
  - 게이트웨이가 노출하는 노드 표면을 감사할 때
title: "브리지 프로토콜"
---

# 브리지 프로토콜 (레거시 노드 전송)

브리지 프로토콜은 **레거시** 노드 전송 (TCP JSONL)입니다. 새로운 노드 클라이언트는
대신 통합된 Gateway WebSocket 프로토콜을 사용해야 합니다.

오퍼레이터 또는 노드 클라이언트를 구축하는 경우,
[Gateway 프로토콜](/gateway/protocol)을 사용하십시오.

**참고:** 현재 OpenClaw 빌드는 더 이상 TCP 브리지 리스너를 포함하지 않습니다. 이 문서는 역사적 참고를 위해 유지됩니다.
레거시 `bridge.*` 설정 키는 더 이상 설정 스키마의 일부가 아닙니다.

## 둘 다 존재하는 이유

- **보안 경계**: 브리지는 전체 게이트웨이 API 표면이 아니라 작은 허용 목록만 노출합니다.
- **페어링 + 노드 ID**: 노드 승인 관리는 게이트웨이가 담당하며 노드별 토큰에 연결됩니다.
- **디바이스 검색 UX**: 노드는 LAN 에서 Bonjour 를 통해 게이트웨이를 검색하거나, tailnet 을 통해 직접 연결할 수 있습니다.
- **루프백 WS**: 전체 WS 제어 평면은 SSH 를 통해 터널링되지 않는 한 로컬에 유지됩니다.

## 전송

- TCP, 한 줄당 하나의 JSON 객체 (JSONL).
- 선택적 TLS (`bridge.tls.enabled` 이 true 인 경우).
- 레거시 기본 리스너 포트는 `18790` 였습니다 (현재 빌드는 TCP 브리지를 시작하지 않습니다).

TLS 가 활성화되면, 디스커버리 TXT 레코드에 `bridgeTls=1` 와
`bridgeTlsSha256` 가 포함되어 노드가 인증서를 고정할 수 있습니다.

## 핸드셰이크 + 페어링

1. 클라이언트가 노드 메타데이터 + 토큰 (이미 페어링된 경우)을 포함한 `hello` 를 전송합니다.
2. 페어링되지 않은 경우, 게이트웨이가 `error` (`NOT_PAIRED`/`UNAUTHORIZED`) 로 응답합니다.
3. 클라이언트가 `pair-request` 를 전송합니다.
4. 게이트웨이는 승인을 대기한 후, `pair-ok` 과 `hello-ok` 를 전송합니다.

`hello-ok` 는 `serverName` 를 반환하며 `canvasHostUrl` 를 포함할 수 있습니다.

## 프레임

클라이언트 → 게이트웨이:

- `req` / `res`: 범위 지정된 게이트웨이 RPC (채팅, 세션, 설정, 상태, voicewake, skills.bins)
- `event`: 노드 신호 (음성 전사, 에이전트 요청, 채팅 구독, exec 수명주기)

게이트웨이 → 클라이언트:

- `invoke` / `invoke-res`: 노드 명령 (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: 구독된 세션에 대한 채팅 업데이트
- `ping` / `pong`: keepalive

레거시 허용 목록 강제는 `src/gateway/server-bridge.ts` 에 존재했습니다 (제거됨).

## Exec 수명주기 이벤트

노드는 system.run 활동을 표면화하기 위해 `exec.finished` 또는 `exec.denied` 이벤트를 발행할 수 있습니다.
이들은 게이트웨이의 시스템 이벤트로 매핑됩니다. (레거시 노드는 여전히 `exec.started` 를 발행할 수 있습니다.)

페이로드 필드 (표기되지 않은 경우 모두 선택 사항):

- `sessionKey` (필수): 시스템 이벤트를 수신할 에이전트 세션.
- `runId`: 그룹화를 위한 고유 exec id.
- `command`: 원시 또는 포맷된 명령 문자열.
- `exitCode`, `timedOut`, `success`, `output`: 완료 세부 정보 (완료된 경우에만).
- `reason`: 거부 사유 (거부된 경우에만).

## Tailnet 사용

- 브리지를 tailnet IP 에 바인딩: `bridge.bind: "tailnet"` 를
  `~/.openclaw/openclaw.json` 에서 설정합니다.
- 클라이언트는 MagicDNS 이름 또는 tailnet IP 를 통해 연결합니다.
- Bonjour 는 **네트워크를 가로지르지 않습니다**; 필요 시 수동 호스트/포트 또는 광역 DNS‑SD 를 사용하십시오.

## 버전 관리

브리지는 현재 **암묵적 v1** 입니다 (최소/최대 협상 없음). 하위 호환성은 기대되며, 호환성을 깨는 변경 전에 브리지 프로토콜 버전 필드를 추가해야 합니다.
