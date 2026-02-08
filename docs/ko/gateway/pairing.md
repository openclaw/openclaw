---
read_when:
    - macOS UI 없이 노드 페어링 승인 구현
    - 원격 노드 승인을 위한 CLI 흐름 추가
    - 노드 관리로 게이트웨이 프로토콜 확장
summary: iOS 및 기타 원격 노드에 대한 게이트웨이 소유 노드 페어링(옵션 B)
title: 게이트웨이 소유 페어링
x-i18n:
    generated_at: "2026-02-08T15:59:40Z"
    model: gtx
    provider: google-translate
    source_hash: 1f5154292a75ea2c1470324babc99c6c46a5e4e16afb394ed323d28f6168f459
    source_path: gateway/pairing.md
    workflow: 15
---

# 게이트웨이 소유 페어링(옵션 B)

게이트웨이 소유 페어링에서는 **게이트웨이** 노드가 해당하는 진실의 소스입니다.
가입이 허용됩니다. UI(macOS 앱, 향후 클라이언트)는 단지 프런트엔드일 뿐입니다.
보류 중인 요청을 승인하거나 거부합니다.

**중요한:** WS 노드 사용 **장치 페어링** (역할 `node`) 동안 `connect`.
`node.pair.*` 별도의 페어링 매장이며 **~ 아니다** WS 핸드셰이크를 게이트로 연결합니다.
명시적으로 호출하는 클라이언트만 `node.pair.*` 이 흐름을 사용하세요.

## 개념

- **요청 대기 중**: 가입을 요청받은 노드; 승인이 필요합니다.
- **페어링된 노드**: 인증 토큰이 발급된 승인된 노드입니다.
- **수송**: Gateway WS 엔드포인트는 요청을 전달하지만 결정하지는 않습니다.
  회원. (레거시 TCP 브리지 지원은 더 이상 사용되지 않거나 제거되었습니다.)

## 페어링 작동 방식

1. 노드는 게이트웨이 WS에 연결하고 페어링을 요청합니다.
2. 게이트웨이는 **요청 대기 중** 그리고 방출한다 `node.pair.requested`.
3. 요청을 승인하거나 거부합니다(CLI 또는 UI).
4. 승인 시 게이트웨이는 **새 토큰** (토큰은 재페어링 시 순환됩니다).
5. 노드는 토큰을 사용하여 다시 연결되고 이제 "페어링"됩니다.

대기 중인 요청은 다음 이후에 자동으로 만료됩니다. **5분**.

## CLI 워크플로(헤드리스 친화적)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 페어링/연결된 노드와 해당 기능을 보여줍니다.

## API 표면(게이트웨이 프로토콜)

이벤트:

- `node.pair.requested` — 보류 중인 새 요청이 생성되면 생성됩니다.
- `node.pair.resolved` — 요청이 승인/거부/만료되면 발생합니다.

행동 양식:

- `node.pair.request` — 보류 중인 요청을 생성하거나 재사용합니다.
- `node.pair.list` — 보류 중인 + 쌍을 이루는 노드를 나열합니다.
- `node.pair.approve` — 보류 중인 요청을 승인합니다(토큰 발행).
- `node.pair.reject` — 보류 중인 요청을 거부합니다.
- `node.pair.verify` - 확인하다 `{ nodeId, token }`.

참고:

- `node.pair.request` 노드당 멱등성이 있습니다. 반복 호출은 동일한 결과를 반환합니다.
  요청 대기 중입니다.
- 승인 **언제나** 새로운 토큰을 생성합니다. 어떤 토큰도 반환되지 않습니다.
  `node.pair.request`.
- 요청에는 다음이 포함될 수 있습니다. `silent: true` 자동 승인 흐름에 대한 힌트로 사용됩니다.

## 자동 승인(macOS 앱)

macOS 앱은 선택적으로 다음을 시도할 수 있습니다. **자동 승인** 언제:

- 요청이 표시되어 있습니다 `silent`, 그리고
- 앱은 동일한 사용자를 사용하여 게이트웨이 호스트에 대한 SSH 연결을 확인할 수 있습니다.

자동 승인이 실패하면 일반적인 "승인/거부" 프롬프트로 돌아갑니다.

## 스토리지(로컬, 프라이빗)

페어링 상태는 게이트웨이 상태 디렉터리(기본값)에 저장됩니다. `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

재정의하는 경우 `OPENCLAW_STATE_DIR`, `nodes/` 폴더도 함께 이동합니다.

보안 참고사항:

- 토큰은 비밀입니다. 대하다 `paired.json` 민감할 정도로.
- 토큰을 순환하려면 재승인(또는 노드 항목 삭제)이 필요합니다.

## 운송 행동

- 운송은 **무국적**; 멤버십은 저장되지 않습니다.
- 게이트웨이가 오프라인이거나 페어링이 비활성화된 경우 노드는 페어링할 수 없습니다.
- 게이트웨이가 원격 모드에 있는 경우에도 원격 게이트웨이의 저장소에 대한 페어링이 계속 발생합니다.
