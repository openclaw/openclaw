---
read_when: Changing onboarding wizard steps or config schema endpoints
summary: 온보딩 마법사 및 구성 스키마에 대한 RPC 프로토콜 참고 사항
title: 온보딩 및 구성 프로토콜
x-i18n:
    generated_at: "2026-02-08T15:52:43Z"
    model: gtx
    provider: google-translate
    source_hash: 55163b3ee029c02476800cb616a054e5adfe97dae5bb72f2763dce0079851e06
    source_path: experiments/onboarding-config-protocol.md
    workflow: 15
---

# 온보딩 + 구성 프로토콜

목적: CLI, macOS 앱 및 웹 UI 전반에 걸쳐 온보딩 + 구성 표면을 공유합니다.

## 구성요소

- 마법사 엔진(공유 세션 + 프롬프트 + 온보딩 상태).
- CLI 온보딩은 UI 클라이언트와 동일한 마법사 흐름을 사용합니다.
- 게이트웨이 RPC는 마법사 + 구성 스키마 엔드포인트를 노출합니다.
- macOS 온보딩은 마법사 단계 모델을 사용합니다.
- 웹 UI는 JSON 스키마 + UI 힌트에서 구성 양식을 렌더링합니다.

## 게이트웨이 RPC

- `wizard.start` 매개변수: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` 매개변수: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` 매개변수: `{ sessionId }`
- `wizard.status` 매개변수: `{ sessionId }`
- `config.schema` 매개변수: `{}`

응답(모양)

- 마법사: `{ sessionId, done, step?, status?, error? }`
- 구성 스키마: `{ schema, uiHints, version, generatedAt }`

## UI 힌트

- `uiHints` 경로로 키 지정; 선택적 메타데이터(레이블/도움말/그룹/주문/고급/민감한/자리 표시자).
- 민감한 필드는 비밀번호 입력으로 렌더링됩니다. 수정 레이어가 없습니다.
- 지원되지 않는 스키마 노드는 원시 JSON 편집기로 대체됩니다.

## 메모

- 이 문서는 온보딩/구성에 대한 프로토콜 리팩터링을 추적할 수 있는 단일 장소입니다.
