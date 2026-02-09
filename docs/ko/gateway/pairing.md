---
summary: "iOS 및 기타 원격 노드를 위한 Gateway 소유 노드 페어링 (옵션 B)"
read_when:
  - macOS UI 없이 노드 페어링 승인 구현
  - 원격 노드 승인용 CLI 흐름 추가
  - 노드 관리를 포함하도록 게이트웨이 프로토콜 확장
title: "Gateway 소유 페어링"
---

# Gateway 소유 페어링 (옵션 B)

Gateway 소유 페어링에서는 **Gateway**가 어떤 노드의 참여를 허용할지에 대한 단일 진실 공급원입니다. UI (macOS 앱, 향후 클라이언트)는 보류 중인 요청을 승인하거나 거부하는 프런트엔드 역할만 합니다.

**중요:** WS 노드는 `connect` 동안 **디바이스 페어링** (역할 `node`)을 사용합니다.
`node.pair.*`은 별도의 페어링 저장소이며 WS 핸드셰이크를 **게이트하지 않습니다**.
`node.pair.*`를 명시적으로 호출하는 클라이언트만 이 흐름을 사용합니다.

## 개념

- **보류 중인 요청**: 노드가 참여를 요청한 상태이며, 승인이 필요합니다.
- **페어링된 노드**: 인증 토큰이 발급된 승인된 노드입니다.
- **전송**: Gateway WS 엔드포인트는 요청을 전달하지만 멤버십을 결정하지 않습니다. (레거시 TCP 브리지 지원은 사용 중단/제거되었습니다.)

## How pairing works

1. 노드가 Gateway WS 에 연결하여 페어링을 요청합니다.
2. Gateway 가 **보류 중인 요청**을 저장하고 `node.pair.requested`를 발생시킵니다.
3. 요청을 승인하거나 거부합니다 (CLI 또는 UI).
4. 승인 시 Gateway 가 **새 토큰**을 발급합니다 (재페어링 시 토큰은 회전됩니다).
5. 노드는 토큰을 사용해 다시 연결하며 이제 “페어링됨” 상태가 됩니다.

보류 중인 요청은 **5 분** 후 자동으로 만료됩니다.

## CLI 워크플로 (헤드리스 친화적)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status`는 페어링/연결된 노드와 해당 기능을 표시합니다.

## API 표면 (게이트웨이 프로토콜)

이벤트:

- `node.pair.requested` — 새 보류 요청이 생성될 때 발생합니다.
- `node.pair.resolved` — 요청이 승인/거부/만료될 때 발생합니다.

메서드:

- `node.pair.request` — 보류 요청을 생성하거나 재사용합니다.
- `node.pair.list` — 보류 + 페어링된 노드를 나열합니다.
- `node.pair.approve` — 보류 요청을 승인합니다 (토큰 발급).
- `node.pair.reject` — 보류 요청을 거부합니다.
- `node.pair.verify` — `{ nodeId, token }`를 검증합니다.

참고 사항:

- `node.pair.request`는 노드별로 멱등적입니다. 반복 호출 시 동일한
  보류 요청을 반환합니다.
- 승인은 **항상** 새로운 토큰을 생성합니다. 어떤 토큰도
  `node.pair.request`에서 반환되지 않습니다.
- 요청에는 자동 승인 흐름을 위한 힌트로 `silent: true`가 포함될 수 있습니다.

## 자동 승인 (macOS 앱)

macOS 앱은 다음 조건에서 선택적으로 **무음 승인**을 시도할 수 있습니다:

- 요청이 `silent`로 표시되어 있고,
- 앱이 동일한 사용자를 사용해 게이트웨이 호스트로의 SSH 연결을 검증할 수 있는 경우.

무음 승인이 실패하면 일반적인 “승인/거부” 프롬프트로 대체됩니다.

## 저장소 (로컬, 비공개)

페어링 상태는 Gateway 상태 디렉토리 아래에 저장됩니다 (기본값 `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR`를 재정의하면 `nodes/` 폴더도 함께 이동합니다.

보안 참고 사항:

- 토큰은 비밀 정보이므로 `paired.json`를 민감 정보로 취급하십시오.
- 토큰을 회전하려면 재승인이 필요합니다 (또는 노드 항목을 삭제).

## 전송 동작

- 전송은 **무상태**이며 멤버십을 저장하지 않습니다.
- Gateway 가 오프라인이거나 페어링이 비활성화된 경우 노드는 페어링할 수 없습니다.
- Gateway 가 원격 모드인 경우에도 페어링은 원격 Gateway 의 저장소를 기준으로 이루어집니다.
