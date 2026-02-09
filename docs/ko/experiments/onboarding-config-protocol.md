---
summary: "온보딩 마법사 및 구성 스키마를 위한 RPC 프로토콜 노트"
read_when: "온보딩 마법사 단계 또는 구성 스키마 엔드포인트를 변경할 때"
title: "온보딩 및 구성 프로토콜"
---

# 온보딩 + 구성 프로토콜

목적: CLI, macOS 앱, Web UI 전반에서 공유되는 온보딩 + 구성 표면을 정의합니다.

## 구성 요소

- 마법사 엔진(공유 세션 + 프롬프트 + 온보딩 상태).
- CLI 온보딩은 UI 클라이언트와 동일한 마법사 흐름을 사용합니다.
- Gateway RPC 는 마법사 + 구성 스키마 엔드포인트를 노출합니다.
- macOS 온보딩은 마법사 단계 모델을 사용합니다.
- Web UI 는 JSON Schema + UI 힌트로부터 구성 폼을 렌더링합니다.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

응답(형태)

- Wizard: `{ sessionId, done, step?, status?, error? }`
- Config schema: `{ schema, uiHints, version, generatedAt }`

## UI 힌트

- 경로로 키가 지정된 `uiHints`; 선택적 메타데이터(label/help/group/order/advanced/sensitive/placeholder).
- 민감한 필드는 비밀번호 입력으로 렌더링됩니다; 별도의 마스킹 레이어는 없습니다.
- 지원되지 않는 스키마 노드는 원시 JSON 편집기로 대체됩니다.

## 참고

- 이 문서는 온보딩/구성에 대한 프로토콜 리팩터링을 추적하는 단일 기준 문서입니다.
