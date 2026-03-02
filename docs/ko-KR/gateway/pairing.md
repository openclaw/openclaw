---
summary: "게이트웨이 소유 노드 페어링(옵션 B) iOS 및 기타 원격 노드용"
read_when:
  - macOS UI 없이 노드 페어링 승인 구현
  - 원격 노드 승인을 위한 CLI 흐름 추가
  - 노드 관리로 게이트웨이 프로토콜 확장
title: "게이트웨이 소유 페어링"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/pairing.md
  workflow: 15
---

# 게이트웨이 소유 페어링(옵션 B)

게이트웨이 소유 페어링에서 **게이트웨이**는 어떤 노드를 허용할지의 진실의 원천입니다. UI(macOS app, 향후 클라이언트)는 단지 보류 중인 요청을 승인하거나 거부하는 프론트엔드입니다.

**중요:** WS 노드는 `connect` 중에 **디바이스 페어링**(역할 `node`)을 사용합니다.
`node.pair.*`는 별도의 페어링 저장소이며 WS 핸드셰이크를 **게이트**하지 않습니다.
`node.pair.*`를 명시적으로 호출하는 클라이언트만 이 흐름을 사용합니다.

## 개념

- **보류 중인 요청**: 노드가 결합을 요청함; 승인 필요.
- **페어링된 노드**: 발급된 인증 토큰이 있는 승인된 노드.
- **전송**: 게이트웨이 WS 끝점이 요청을 전달하지만 멤버십을 결정하지 않습니다. (레거시 TCP 브리지 지원은 더 이상 사용되지 않음/제거됨.)

## 페어링 작동 방식

1. 노드가 게이트웨이 WS에 연결하고 페어링을 요청합니다.
2. 게이트웨이가 **보류 중인 요청**을 저장하고 `node.pair.requested`를 발생시킵니다.
3. 요청을 승인하거나 거부합니다(CLI 또는 UI).
4. 승인할 때 게이트웨이가 **새 토큰**을 발급합니다(토큰은 재페어링 시 회전됨).
5. 노드가 토큰을 사용하여 다시 연결하고 이제 "페어링됨"입니다.

보류 중인 요청은 **5분** 후 자동으로 만료됩니다.

## CLI 워크플로우(헤드리스 친화적)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status`는 페어링된/연결된 노드 및 기능을 표시합니다.

## API 표면(게이트웨이 프로토콜)

이벤트:

- `node.pair.requested` — 새로운 보류 중인 요청이 생성될 때 발생.
- `node.pair.resolved` — 요청이 승인/거부/만료될 때 발생.

메서드:

- `node.pair.request` — 보류 중인 요청을 생성하거나 재사용.
- `node.pair.list` — 보류 중 + 페어링된 노드 나열.
- `node.pair.approve` — 보류 중인 요청 승인(토큰 발급).
- `node.pair.reject` — 보류 중인 요청 거부.
- `node.pair.verify` — `{ nodeId, token }` 확인.

참고:

- `node.pair.request`는 노드별로 멱등성입니다. 반복 호출이 동일한 보류 중인 요청을 반환합니다.
- 승인이 항상 새 토큰을 생성합니다. `node.pair.request`에서 토큰이 반환되지 않습니다.
- 요청에 `silent: true`가 포함될 수 있습니다 자동 승인 흐름의 힌트로.

## 자동 승인(macOS app)

macOS app은 다음 경우에 **자동 승인**을 시도할 수 있습니다:

- 요청이 `silent` 표시됨, 그리고
- app이 동일한 사용자를 사용하여 게이트웨이 호스트에 SSH 연결을 확인할 수 있습니다.

자동 승인이 실패하면 정상 "Approve/Reject" 프롬프트로 폴백합니다.

## 저장소(로컬, 개인)

페어링 상태는 게이트웨이 상태 디렉토리(기본값 `~/.openclaw`) 아래에 저장됩니다:

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR`을 재정의하면 `nodes/` 폴더가 함께 이동합니다.

보안 참고:

- 토큰은 비밀입니다. `paired.json`을 민감한 것으로 취급합니다.
- 토큰 회전에는 재승인이 필요합니다(또는 노드 항목 삭제).

## 전송 동작

- 전송은 **상태 비저장**입니다. 멤버십을 저장하지 않습니다.
- 게이트웨이가 오프라인이거나 페어링이 비활성화되면 노드는 페어링할 수 없습니다.
- 게이트웨이가 원격 모드에 있으면 페어링이 여전히 원격 게이트웨이의 저장소에 대해 발생합니다.
