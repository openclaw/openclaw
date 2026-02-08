---
read_when:
    - 노드 클라이언트 빌드 또는 디버깅(iOS/Android/macOS 노드 모드)
    - 페어링 또는 브리지 인증 실패 조사
    - 게이트웨이에 의해 노출된 노드 표면 감사
summary: '브리지 프로토콜(레거시 노드): TCP JSONL, 페어링, 범위가 지정된 RPC'
title: 브리지 프로토콜
x-i18n:
    generated_at: "2026-02-08T15:57:49Z"
    model: gtx
    provider: google-translate
    source_hash: 789bcf3cbc6841fc293e054b919e63d661b3cc4cd205b2094289f00800127fe2
    source_path: gateway/bridge-protocol.md
    workflow: 15
---

# 브리지 프로토콜(레거시 노드 전송)

브리지 프로토콜은 **유산** 노드 전송(TCP JSONL). 새로운 노드 클라이언트
대신 통합 게이트웨이 WebSocket 프로토콜을 사용해야 합니다.

운영자 또는 노드 클라이언트를 구축하는 경우 다음을 사용하십시오.
[게이트웨이 프로토콜](/gateway/protocol).

**메모:** 현재 OpenClaw 빌드는 더 이상 TCP 브리지 리스너를 제공하지 않습니다. 이 문서는 역사적 참고를 위해 보관됩니다.
유산 `bridge.*` 구성 키는 더 이상 구성 스키마의 일부가 아닙니다.

## 우리 둘 다 있는 이유

- **보안 경계**: 브리지는 대신 작은 허용 목록을 노출합니다.
  전체 게이트웨이 API 표면.
- **페어링 + 노드 ID**: 노드 승인은 게이트웨이가 소유하며 묶여 있습니다.
  노드별 토큰으로.
- **디스커버리UX**: 노드는 LAN의 Bonjour를 통해 게이트웨이를 검색하거나 연결할 수 있습니다.
  tailnet 바로 위에.
- **루프백 WS**: 전체 WS 제어 평면은 SSH를 통해 터널링되지 않는 한 로컬로 유지됩니다.

## 수송

- TCP, 한 줄에 하나의 JSON 개체(JSONL).
- 선택적 TLS(경우 `bridge.tls.enabled` 사실이다).
- 이전 기본 리스너 포트는 다음과 같습니다. `18790` (현재 빌드는 TCP 브리지를 시작하지 않습니다).

TLS가 활성화되면 검색 TXT 레코드에는 다음이 포함됩니다. `bridgeTls=1` ...을 더한
`bridgeTlsSha256` 그러면 노드가 인증서를 고정할 수 있습니다.

## 악수 + 페어링

1. 클라이언트가 보냅니다. `hello` 노드 메타데이터 + 토큰 포함(이미 페어링된 경우)
2. 페어링되지 않은 경우 게이트웨이가 응답합니다. `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. 클라이언트가 보냅니다. `pair-request`.
4. 게이트웨이는 승인을 기다린 후 전송합니다. `pair-ok` 그리고 `hello-ok`.

`hello-ok` 보고 `serverName` 그리고 다음을 포함할 수도 있습니다 `canvasHostUrl`.

## 프레임

클라이언트 → 게이트웨이:

- `req`/`res`: 범위가 지정된 게이트웨이 RPC(채팅, 세션, 구성, 상태, voicewake, Skill.bins)
- `event`: 노드 신호(음성 기록, 에이전트 요청, 채팅 구독, 실행 수명 주기)

게이트웨이 → 클라이언트:

- `invoke`/`invoke-res`: 노드 명령(`canvas.*`, `camera.*`, `screen.record`, 
  `location.get`, `sms.send`)
- `event`: 구독한 세션에 대한 채팅 업데이트
- `ping`/`pong`: 연결 유지

기존 허용 목록 시행 `src/gateway/server-bridge.ts` (제거됨).

## Exec 수명주기 이벤트

노드는 방출할 수 있습니다 `exec.finished` 또는 `exec.denied` system.run 활동을 표면화하는 이벤트.
이는 게이트웨이의 시스템 이벤트에 매핑됩니다. (레거시 노드는 여전히 방출할 수 있습니다. `exec.started`.)

페이로드 필드(별도 언급이 없는 한 모두 선택 사항):

- `sessionKey` (필수): 시스템 이벤트를 수신하기 위한 에이전트 세션입니다.
- `runId`: 그룹화를 위한 고유한 실행 ID입니다.
- `command`: 원시 또는 형식화된 명령 문자열입니다.
- `exitCode`, `timedOut`, `success`, `output`: 완료 세부정보(완료된 경우에만).
- `reason`: 거부 이유(거부된 경우에만 해당)

## 테일넷 사용법

- 브리지를 tailnet IP에 바인딩합니다. `bridge.bind: "tailnet"` ~에
  `~/.openclaw/openclaw.json`.
- 클라이언트는 MagicDNS 이름 또는 tailnet IP를 통해 연결됩니다.
- 봉쥬르가 그렇죠 **~ 아니다** 교차 네트워크; 수동 호스트/포트 또는 광역 DNS‑SD 사용
  필요할 때.

## 버전 관리

브릿지는 현재 **암시적 v1** (최소/최대 협상 없음). 이전 버전과 호환
예상됩니다; 주요 변경 사항이 발생하기 전에 브리지 프로토콜 버전 필드를 추가하세요.
