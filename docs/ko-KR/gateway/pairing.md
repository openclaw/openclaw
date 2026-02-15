---
summary: "Gateway-owned node pairing (Option B) for iOS and other remote nodes"
read_when:
  - Implementing node pairing approvals without macOS UI
  - Adding CLI flows for approving remote nodes
  - Extending gateway protocol with node management
title: "Gateway-Owned Pairing"
x-i18n:
  source_hash: 1f5154292a75ea2c1470324babc99c6c46a5e4e16afb394ed323d28f6168f459
---

# 게이트웨이 소유 페어링(옵션 B)

게이트웨이 소유 페어링에서 **게이트웨이**는 노드에 대한 정보 소스입니다.
가입이 허용됩니다. UI(macOS 앱, 향후 클라이언트)는 단지 프런트엔드일 뿐입니다.
보류 중인 요청을 승인하거나 거부합니다.

**중요:** WS 노드는 `connect` 동안 **장치 페어링**(역할 `node`)을 사용합니다.
`node.pair.*`는 별도의 페어링 저장소이며 WS 핸드셰이크를 **하지** 않습니다.
`node.pair.*`를 명시적으로 호출하는 클라이언트만 이 흐름을 사용합니다.

## 개념

- **요청 대기 중**: 참여를 요청한 노드입니다. 승인이 필요합니다.
- **페어링된 노드**: 인증 토큰이 발급된 승인된 노드입니다.
- **전송**: 게이트웨이 WS 끝점이 요청을 전달하지만 결정하지는 않습니다.
  회원. (레거시 TCP 브리지 지원은 더 이상 사용되지 않거나 제거되었습니다.)

## 페어링 작동 방식

1. 노드가 Gateway WS에 연결하고 페어링을 요청합니다.
2. 게이트웨이는 **보류 중인 요청**을 저장하고 `node.pair.requested`를 내보냅니다.
3. 요청을 승인하거나 거부합니다(CLI 또는 UI).
4. 승인 시 게이트웨이는 **새 토큰**을 발행합니다(토큰은 수리 시 순환됩니다).
5. 노드는 토큰을 사용하여 다시 연결되며 이제 "페어링"됩니다.

대기 중인 요청은 **5분** 후에 자동으로 만료됩니다.

## CLI 워크플로(헤드리스 친화적)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status`은 페어링/연결된 노드와 해당 기능을 보여줍니다.

## API 표면(게이트웨이 프로토콜)

이벤트:

- `node.pair.requested` — 보류 중인 새 요청이 생성될 때 생성됩니다.
- `node.pair.resolved` — 요청이 승인/거부/만료될 때 생성됩니다.

방법:

- `node.pair.request` — 보류 중인 요청을 생성하거나 재사용합니다.
- `node.pair.list` — 보류 중인 + 쌍을 이루는 노드를 나열합니다.
- `node.pair.approve` — 보류 중인 요청을 승인합니다(토큰 발행).
- `node.pair.reject` — 보류 중인 요청을 거부합니다.
- `node.pair.verify` — `{ nodeId, token }`를 확인합니다.

참고:

- `node.pair.request`는 노드당 멱등성이 있습니다. 반복 호출은 동일한 결과를 반환합니다.
  요청 대기 중입니다.
- 승인은 **항상** 새로운 토큰을 생성합니다. 어떤 토큰도 반환되지 않습니다.
  `node.pair.request`.
- 요청에는 자동 승인 흐름에 대한 힌트로 `silent: true`가 포함될 수 있습니다.

## 자동 승인(macOS 앱)

macOS 앱은 다음과 같은 경우 선택적으로 **자동 승인**을 시도할 수 있습니다.

- 요청은 `silent`로 표시되며,
- 앱은 동일한 사용자를 사용하여 게이트웨이 호스트에 대한 SSH 연결을 확인할 수 있습니다.

자동 승인이 실패하면 일반적인 "승인/거부" 프롬프트로 돌아갑니다.

## 스토리지(로컬, 프라이빗)

페어링 상태는 게이트웨이 상태 디렉터리(기본값 `~/.openclaw`)에 저장됩니다.

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

`OPENCLAW_STATE_DIR`를 재정의하면 `nodes/` 폴더도 함께 이동됩니다.

보안 참고 사항:

- 토큰은 비밀입니다. `paired.json`를 민감하게 취급합니다.
- 토큰을 순환하려면 재승인(또는 노드 항목 삭제)이 필요합니다.

## 전송 동작

- 전송은 **상태 비저장**입니다. 멤버십은 저장되지 않습니다.
- 게이트웨이가 오프라인이거나 페어링이 비활성화된 경우 노드는 페어링할 수 없습니다.
- 게이트웨이가 원격 모드인 경우에도 원격 게이트웨이의 저장소에 대해 페어링이 이루어집니다.
