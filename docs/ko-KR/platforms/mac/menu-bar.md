---
summary: "메뉴 바 상태 로직 및 사용자에게 표시되는 것"
read_when:
  - mac 메뉴 UI 또는 상태 로직을 조정할 때
title: "메뉴 바"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/menu-bar.md"
  workflow: 15
---

# 메뉴 바 상태 로직

## 표시되는 것

- 메뉴 바 아이콘과 메뉴의 첫 번째 상태 행에서 현재 에이전트 작업 상태를 표시합니다.
- 헬스 상태는 작업이 활성화되는 동안 숨겨집니다. 모든 세션이 유휴 상태가 되면 반환됩니다.
- 메뉴의 "Nodes" 블록은 **장치**만 나열합니다 (노드를 통한 쌍을 이룬 노드 `node.list`), 클라이언트/현재 항목은 아닙니다.
- "Usage" 섹션은 공급자 사용량 스냅샷을 사용할 수 있을 때 Context 아래에 나타납니다.

## 상태 모델

- 세션: 이벤트는 `runId` (실행별) 및 페이로드의 `sessionKey`와 함께 도착합니다. "main" 세션은 키 `main`입니다. 없으면, 가장 최근에 업데이트된 세션으로 폴백합니다.
- 우선순위: main이 항상 우승합니다. main이 활성화되면, 해당 상태는 즉시 표시됩니다. main이 유휴 상태이면, 가장 최근에 활성화된 비-main 세션이 표시됩니다. 활동 중에는 플립-플롭하지 않습니다. 현재 세션이 유휴 상태가 되거나 main이 활성화될 때만 전환합니다.
- 활동 종류:
  - `job`: 고수준 명령어 실행 (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` with `toolName` and `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (디버그 재정의)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### 시각적 매핑

- `idle`: 정상 크리터.
- `workingMain`: 배지 with glyph, 전체 tint, 다리 "working" 애니메이션.
- `workingOther`: 배지 with glyph, 음소거된 tint, 스커리 없음.
- `overridden`: 활동에 관계없이 선택한 glyph/tint를 사용합니다.

## 상태 행 텍스트 (메뉴)

- 작업이 활성화되는 동안: `<Session role> · <activity label>`
  - 예: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- 유휴 상태일 때: 헬스 요약으로 폴백합니다.

## 이벤트 수집

- 출처: control-channel `agent` 이벤트 (`ControlChannel.handleAgentEvent`).
- 구문 분석된 필드:
  - `stream: "job"` with `data.state` for start/stop.
  - `stream: "tool"` with `data.phase`, `name`, optional `meta`/`args`.
- 레이블:
  - `exec`: `args.command`의 첫 줄.
  - `read`/`write`: 단축된 경로.
  - `edit`: 경로 plus inferred change kind from `meta`/diff counts.
  - fallback: 도구 이름.

## 디버그 재정의

- Settings ▸ Debug ▸ "Icon override" 선택기:
  - `System (auto)` (기본값)
  - `Working: main` (도구 종류별)
  - `Working: other` (도구 종류별)
  - `Idle`
- `@AppStorage("iconOverride")`를 통해 저장됨. `IconState.overridden`으로 매핑됨.

## 테스팅 체크리스트

- main 세션 작업 트리거: 아이콘이 즉시 전환되고 상태 행이 main 레이블을 표시하는지 확인합니다.
- main이 유휴 상태인 동안 비-main 세션 작업 트리거: 아이콘/상태가 비-main을 표시합니다. 종료될 때까지 안정적으로 유지됩니다.
- main이 다른 활성화되는 동안 시작: 아이콘이 즉시 main으로 뒤집습니다.
- 빠른 도구 버스트: 배지가 깜박이지 않도록 보장합니다 (도구 결과에 TTL 유예).
- 모든 세션이 유휴 상태가 되면 헬스 행이 다시 나타납니다.
