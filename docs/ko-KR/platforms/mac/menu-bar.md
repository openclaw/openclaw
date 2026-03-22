---
summary: "메뉴 바 상태 로직 및 사용자에게 표시되는 내용"
read_when:
  - Mac 메뉴 UI 또는 상태 로직을 조정할 때
title: "메뉴 바"
x-i18n:
  source_path: docs/platforms/mac/menu-bar.md
---

# 메뉴 바 상태 로직

## 표시 내용

- 메뉴 바 아이콘과 메뉴의 첫 번째 상태 행에 현재 에이전트 작업 상태를 표시합니다.
- 작업이 활성 상태일 때는 상태 표시가 숨겨지며; 모든 세션이 유휴 상태가 되면 다시 표시됩니다.
- 메뉴의 "노드" 블록은 **기기**만 나열합니다 (페어링된 노드, `node.list` 를 통해), 클라이언트/프레즌스 항목은 아닙니다.
- 프로바이더 사용량 스냅샷이 사용 가능할 때 컨텍스트 아래에 "사용량" 섹션이 나타납니다.

## 상태 모델

- 세션: 이벤트는 `runId` (실행 단위) 와 페이로드의 `sessionKey` 와 함께 도착합니다. "main" 세션은 키 `main`입니다; 없으면 가장 최근에 업데이트된 세션으로 폴백합니다.
- 우선순위: main 이 항상 우선합니다. main 이 활성이면 상태가 즉시 표시됩니다. main 이 유휴이면 가장 최근에 활성인 non-main 세션이 표시됩니다. 활동 중에는 전환하지 않습니다; 현재 세션이 유휴 상태가 되거나 main 이 활성화될 때만 전환합니다.
- 활동 종류:
  - `job`: 상위 수준 명령 실행 (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result`, `toolName` 과 `meta/args` 포함.

## IconState 열거형 (Swift)

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
- `workingMain`: 글리프가 있는 배지, 전체 틴트, 다리 "작업" 애니메이션.
- `workingOther`: 글리프가 있는 배지, 음소거된 틴트, 스커리 없음.
- `overridden`: 활동에 관계없이 선택한 글리프/틴트를 사용.

## 상태 행 텍스트 (메뉴)

- 작업 활성 시: `<세션 역할> · <활동 라벨>`
  - 예시: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- 유휴 시: 상태 요약으로 폴백.

## 이벤트 수집

- 소스: 제어 채널 `agent` 이벤트 (`ControlChannel.handleAgentEvent`).
- 파싱 필드:
  - `stream: "job"`, `data.state` 로 시작/중지.
  - `stream: "tool"`, `data.phase`, `name`, 선택적 `meta`/`args`.
- 라벨:
  - `exec`: `args.command` 의 첫 번째 줄.
  - `read`/`write`: 축약된 경로.
  - `edit`: 경로와 `meta`/diff 카운트에서 추론된 변경 종류.
  - 폴백: 도구 이름.

## 디버그 오버라이드

- 설정 → 디버그 → "아이콘 오버라이드" 피커:
  - `System (auto)` (기본값)
  - `Working: main` (도구 종류별)
  - `Working: other` (도구 종류별)
  - `Idle`
- `@AppStorage("iconOverride")` 로 저장; `IconState.overridden` 에 매핑.

## 테스트 체크리스트

- main 세션 작업 트리거: 아이콘이 즉시 전환되고 상태 행에 main 라벨이 표시되는지 확인.
- main 유휴 시 non-main 세션 작업 트리거: 아이콘/상태에 non-main 표시; 완료될 때까지 안정 유지.
- 다른 세션이 활성 상태일 때 main 시작: 아이콘이 즉시 main 으로 전환.
- 빠른 도구 연속 실행: 배지가 깜빡이지 않는지 확인 (도구 결과에 TTL 유예).
- 모든 세션이 유휴 상태가 되면 상태 행이 다시 나타남.
