---
summary: "메뉴 막대 상태 로직과 사용자에게 노출되는 항목"
read_when:
  - mac 메뉴 UI 또는 상태 로직을 조정할 때
title: "메뉴 막대"
---

# 메뉴 막대 상태 로직

## 표시되는 내용

- 메뉴 막대 아이콘과 메뉴의 첫 번째 상태 행에 현재 에이전트 작업 상태를 표시합니다.
- 작업이 활성화되어 있는 동안에는 상태 점검 정보가 숨겨지며, 모든 세션이 유휴 상태가 되면 다시 표시됩니다.
- 메뉴의 'Nodes' 블록에는 클라이언트/프레즌스 항목이 아니라 **디바이스**만 나열됩니다(`node.list`를 통해 페어링된 노드).
- 프로바이더 사용량 스냅샷을 사용할 수 있을 때 Context 아래에 'Usage' 섹션이 나타납니다.

## 상태 모델

- 세션: 이벤트는 `runId`(실행별)과 페이로드의 `sessionKey`와 함께 도착합니다. '메인' 세션은 키 `main`입니다. 없을 경우 가장 최근에 업데이트된 세션으로 대체합니다.
- 우선순위: 메인이 항상 우선합니다. 메인이 활성 상태이면 즉시 해당 상태를 표시합니다. 메인이 유휴 상태이면 가장 최근에 활성화된 비메인 세션을 표시합니다. 활동 도중에는 상태를 오락가락하지 않으며, 현재 세션이 유휴 상태가 되거나 메인이 활성화될 때만 전환합니다.
- 활동 유형:
  - `job`: 상위 수준 명령 실행(`state: started|streaming|done|error`).
  - `tool`: `phase: start|result`에 `toolName` 및 `meta/args` 포함.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (디버그 오버라이드)

### ActivityKind → 글리프

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- 기본값 → 🛠️

### 시각적 매핑

- `idle`: 일반 크리터.
- `workingMain`: 글리프가 있는 배지, 전체 틴트, 다리 '작업 중' 애니메이션.
- `workingOther`: 글리프가 있는 배지, 음소거된 틴트, 이동 애니메이션 없음.
- `overridden`: 활동과 무관하게 선택된 글리프/틴트를 사용합니다.

## 상태 행 텍스트(메뉴)

- 작업이 활성화된 동안: `<Session role> · <activity label>`
  - 예시: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- 31. 유휴 상태일 때: 상태 요약으로 되돌아갑니다.

## 이벤트 수집

- 소스: 컨트롤 채널 `agent` 이벤트(`ControlChannel.handleAgentEvent`).
- 파싱된 필드:
  - 시작/중지를 위한 `stream: "job"` 및 `data.state`.
  - `data.phase`, `name`, 선택적 `meta`/`args`를 포함한 `stream: "tool"`.
- 라벨:
  - `exec`: `args.command`의 첫 번째 줄.
  - `read`/`write`: 축약된 경로.
  - `edit`: `meta`/diff 개수에서 추론한 변경 유형을 포함한 경로.
  - 대체값: 도구 이름.

## 디버그 오버라이드

- 설정 ▸ 디버그 ▸ 'Icon override' 선택기:
  - `System (auto)` (기본값)
  - `Working: main` (도구 유형별)
  - `Working: other` (도구 유형별)
  - `Idle`
- `@AppStorage("iconOverride")`를 통해 저장되며 `IconState.overridden`에 매핑됩니다.

## 테스트 체크리스트

- 메인 세션 작업 트리거: 아이콘이 즉시 전환되고 상태 행에 메인 라벨이 표시되는지 확인합니다.
- 메인이 유휴 상태일 때 비메인 세션 작업 트리거: 아이콘/상태에 비메인이 표시되고, 완료될 때까지 안정적으로 유지되는지 확인합니다.
- 다른 세션이 활성 상태일 때 메인 시작: 아이콘이 즉시 메인으로 전환되는지 확인합니다.
- 빠른 도구 연속 실행: 배지가 깜박이지 않는지 확인합니다(도구 결과에 대한 TTL 유예).
- 32. 모든 세션이 유휴 상태가 되면 상태 행이 다시 나타납니다.
