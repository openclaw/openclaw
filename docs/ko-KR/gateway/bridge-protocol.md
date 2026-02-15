---
summary: "Bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Building or debugging node clients (iOS/Android/macOS node mode)
  - Investigating pairing or bridge auth failures
  - Auditing the node surface exposed by the gateway
title: "Bridge Protocol"
x-i18n:
  source_hash: 789bcf3cbc6841fc293e054b919e63d661b3cc4cd205b2094289f00800127fe2
---

# 브리지 프로토콜(레거시 노드 전송)

브리지 프로토콜은 **레거시** 노드 전송(TCP JSONL)입니다. 새로운 노드 클라이언트
대신 통합 게이트웨이 WebSocket 프로토콜을 사용해야 합니다.

운영자 또는 노드 클라이언트를 구축하는 경우 다음을 사용하십시오.
[게이트웨이 프로토콜](/gateway/protocol).

**참고:** 현재 OpenClaw 빌드는 더 이상 TCP 브리지 리스너를 제공하지 않습니다. 이 문서는 역사적 참고를 위해 보관됩니다.
레거시 `bridge.*` 구성 키는 더 이상 구성 스키마의 일부가 아닙니다.

## 우리가 둘 다 가지고 있는 이유

- **보안 경계**: 브리지는 허용 목록 대신 작은 허용 목록을 노출합니다.
  전체 게이트웨이 API 표면.
- **페어링 + 노드 ID**: 노드 승인은 게이트웨이가 소유하며 연결됩니다.
  노드별 토큰으로.
- **검색 UX**: 노드는 LAN에서 Bonjour를 통해 게이트웨이를 검색하거나 연결할 수 있습니다.
  tailnet 바로 위에.
- **루프백 WS**: 전체 WS 제어 평면은 SSH를 통해 터널링되지 않는 한 로컬로 유지됩니다.

## 운송

- TCP, 한 줄에 하나의 JSON 개체(JSONL).
- 선택적 TLS(`bridge.tls.enabled`가 true인 경우).
- 레거시 기본 리스너 포트는 `18790`였습니다(현재 빌드는 TCP 브리지를 시작하지 않습니다).

TLS가 활성화되면 검색 TXT 레코드에는 `bridgeTls=1` 플러스가 포함됩니다.
`bridgeTlsSha256` 노드가 인증서를 고정할 수 있도록 합니다.

## 악수 + 페어링

1. 클라이언트는 노드 메타데이터 + 토큰(이미 페어링된 경우)과 함께 `hello`를 보냅니다.
2. 페어링되지 않은 경우 게이트웨이는 `error` (`NOT_PAIRED`/`UNAUTHORIZED`)로 응답합니다.
3. 클라이언트는 `pair-request`를 보냅니다.
4. 게이트웨이는 승인을 기다린 후 `pair-ok` 및 `hello-ok`를 보냅니다.

`hello-ok`는 `serverName`를 반환하며 `canvasHostUrl`를 포함할 수 있습니다.

## 프레임

클라이언트 → 게이트웨이:

- `req` / `res`: 범위가 지정된 게이트웨이 RPC(채팅, 세션, 구성, 상태, voicewake, Skill.bins)
- `event`: 노드 신호(음성 기록, 에이전트 요청, 채팅 구독, 실행 수명 주기)

게이트웨이 → 클라이언트:

- `invoke` / `invoke-res`: 노드 명령 (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: 구독 세션에 대한 채팅 업데이트
- `ping` / `pong`: 연결 유지

`src/gateway/server-bridge.ts`에 기존 허용 목록 적용이 적용되었습니다(제거됨).

## Exec 수명주기 이벤트

노드는 `exec.finished` 또는 `exec.denied` 이벤트를 표면 system.run 활동으로 내보낼 수 있습니다.
이는 게이트웨이의 시스템 이벤트에 매핑됩니다. (레거시 노드는 여전히 `exec.started`를 방출할 수 있습니다.)

페이로드 필드(별도 언급이 없는 한 모두 선택 사항):

- `sessionKey` (필수) : 시스템 이벤트를 수신하기 위한 에이전트 세션입니다.
- `runId`: 그룹화를 위한 고유한 실행 ID입니다.
- `command`: 원시 또는 형식화된 명령 문자열.
- `exitCode`, `timedOut`, `success`, `output` : 완료 내용(완료된 경우에만 해당)
- `reason` : 거부 사유(거부만 해당)

## 테일넷 사용법

- 브리지를 tailnet IP에 바인딩합니다: `bridge.bind: "tailnet"`
  `~/.openclaw/openclaw.json`.
- 클라이언트는 MagicDNS 이름 또는 tailnet IP를 통해 연결됩니다.
- Bonjour는 네트워크를 교차하지 **않습니다**. 수동 호스트/포트 또는 광역 DNS‑SD 사용
  필요할 때.

## 버전 관리

Bridge는 현재 **암시적 v1**입니다(최소/최대 협상 없음). 이전 버전과 호환
예상됩니다; 주요 변경 사항이 발생하기 전에 브리지 프로토콜 버전 필드를 추가하세요.
