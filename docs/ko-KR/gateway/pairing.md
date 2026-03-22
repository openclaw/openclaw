---
summary: "Gateway 소유 노드 페어링 (옵션 B): iOS 및 기타 원격 노드용"
read_when:
  - macOS UI 없이 노드 페어링 승인을 구현할 때
  - 원격 노드 승인을 위한 CLI 플로우를 추가할 때
  - 노드 관리로 Gateway 프로토콜을 확장할 때
title: "Gateway 소유 페어링"
x-i18n:
  source_path: docs/gateway/pairing.md
---

# Gateway 소유 페어링 (옵션 B)

Gateway 소유 페어링에서는 **Gateway**가 어떤 노드가 참여할 수 있는지에 대한 진실의 원천입니다. UI (macOS 앱, 향후 클라이언트)는 대기 중인 요청을 승인하거나 거부하는 프론트엔드일 뿐입니다.

**중요:** WS 노드는 `connect` 중에 **디바이스 페어링** (역할 `node`)을 사용합니다. `node.pair.*`는 별도의 페어링 저장소이며 WS 핸드셰이크를 **게이트하지 않습니다**. `node.pair.*`를 명시적으로 호출하는 클라이언트만 이 플로우를 사용합니다.

## 개념

- **대기 중인 요청**: 노드가 참여를 요청했으며 승인이 필요합니다.
- **페어링된 노드**: 발급된 인증 토큰을 가진 승인된 노드.
- **전송**: Gateway WS 엔드포인트가 요청을 전달하지만 멤버십을 결정하지 않습니다. (레거시 TCP 브릿지 지원은 더 이상 사용되지 않거나 제거됨.)

## 페어링 작동 방식

1. 노드가 Gateway WS에 연결하고 페어링을 요청합니다.
2. Gateway가 **대기 중인 요청**을 저장하고 `node.pair.requested`를 발생시킵니다.
3. 요청을 승인 또는 거부합니다 (CLI 또는 UI).
4. 승인 시, Gateway가 **새 토큰**을 발급합니다 (재페어링 시 토큰이 순환됨).
5. 노드가 토큰을 사용하여 재연결하면 "페어링됨" 상태가 됩니다.

대기 중인 요청은 **5분** 후에 자동으로 만료됩니다.

## CLI 워크플로우 (헤드리스 친화적)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status`는 페어링/연결된 노드와 그 기능을 표시합니다.

## API 표면 (Gateway 프로토콜)

이벤트:

- `node.pair.requested` -- 새 대기 중인 요청이 생성될 때 발생.
- `node.pair.resolved` -- 요청이 승인/거부/만료될 때 발생.

메서드:

- `node.pair.request` -- 대기 중인 요청을 생성하거나 재사용.
- `node.pair.list` -- 대기 중 + 페어링된 노드 목록.
- `node.pair.approve` -- 대기 중인 요청 승인 (토큰 발급).
- `node.pair.reject` -- 대기 중인 요청 거부.
- `node.pair.verify` -- `{ nodeId, token }` 검증.

참고:

- `node.pair.request`는 노드별로 멱등적입니다: 반복 호출은 동일한 대기 중인 요청을 반환합니다.
- 승인은 **항상** 새 토큰을 생성합니다. `node.pair.request`에서 토큰이 반환되지 않습니다.
- 요청에 자동 승인 플로우를 위한 힌트로 `silent: true`를 포함할 수 있습니다.

## 자동 승인 (macOS 앱)

macOS 앱은 다음 조건에서 선택적으로 **사일런트 승인**을 시도할 수 있습니다:

- 요청이 `silent`으로 표시되고,
- 앱이 동일한 사용자로 Gateway 호스트에 대한 SSH 연결을 검증할 수 있을 때.

사일런트 승인이 실패하면, 일반 "승인/거부" 프롬프트로 폴백합니다.

## 저장소 (로컬, 비공개)

페어링 상태는 Gateway 상태 디렉토리 (기본값 `~/.openclaw`) 아래에 저장됩니다:

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR`을 재정의하면, `nodes/` 폴더가 함께 이동합니다.

보안 참고:

- 토큰은 시크릿입니다. `paired.json`을 민감하게 취급하세요.
- 토큰 순환에는 재승인이 필요합니다 (또는 노드 항목 삭제).

## 전송 동작

- 전송은 **상태 비저장**입니다. 멤버십을 저장하지 않습니다.
- Gateway가 오프라인이거나 페어링이 비활성화되면, 노드가 페어링할 수 없습니다.
- Gateway가 원격 모드이면, 페어링은 여전히 원격 Gateway의 저장소에 대해 발생합니다.
