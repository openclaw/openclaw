```markdown
---
summary: "온보딩 마법사 및 설정 스키마를 위한 RPC 프로토콜 주의사항"
read_when: "온보딩 마법사 단계 또는 설정 스키마 엔드포인트 변경 시"
title: "온보딩 및 설정 프로토콜"
---

# 온보딩 + 설정 프로토콜

목적: CLI, macOS 앱 및 웹 UI 전반에 걸친 공통 온보딩 + 설정 인터페이스 제공.

## 구성 요소

- 마법사 엔진 (공유 세션 + 프롬프트 + 온보딩 상태).
- CLI 온보딩은 UI 클라이언트와 동일한 마법사 흐름을 사용.
- 게이트웨이 RPC는 마법사 + 설정 스키마 엔드포인트를 노출.
- macOS 온보딩은 마법사 단계 모델을 사용.
- 웹 UI는 JSON 스키마 + UI 힌트로부터 설정 양식을 렌더링.

## 게이트웨이 RPC

- `wizard.start` 매개변수: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` 매개변수: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` 매개변수: `{ sessionId }`
- `wizard.status` 매개변수: `{ sessionId }`
- `config.schema` 매개변수: `{}`

응답 형태

- 마법사: `{ sessionId, done, step?, status?, error? }`
- 설정 스키마: `{ schema, uiHints, version, generatedAt }`

## UI 힌트

- `uiHints`는 경로별로 키 지정; 선택적 메타데이터 (레이블/도움말/그룹/순서/고급/민감/플레이스홀더).
- 민감한 필드는 비밀번호 입력으로 렌더링; 삭제 레이어 없음.
- 지원되지 않는 스키마 노드는 원시 JSON 편집기로 되돌아감.

## 주의사항

- 이 문서는 온보딩/설정 프로토콜 리팩터링을 추적하는 유일한 문서입니다.
```
