---
summary: "Menu bar status logic and what is surfaced to users"
read_when:
  - Tweaking mac menu UI or status logic
title: "Menu Bar"
x-i18n:
  source_hash: 8eb73c0e671a76aae4ebb653c65147610bf3e6d3c9c0943d150e292e7761d16d
---

# 메뉴바 상태 로직

## 보여지는 것

- 메뉴 표시줄 아이콘과 메뉴의 첫 번째 상태 행에 현재 상담원 작업 상태가 표시됩니다.
- 작업이 진행되는 동안 건강 상태는 숨겨집니다. 모든 세션이 유휴 상태일 때 반환됩니다.
- 메뉴의 "노드" 블록에는 클라이언트/현재 항목이 아닌 **장치**(`node.list`를 통해 페어링된 노드)만 나열됩니다.
- 공급자 사용량 스냅샷을 사용할 수 있는 경우 컨텍스트 아래에 "사용량" 섹션이 나타납니다.

## 상태 모델

- 세션: 이벤트는 페이로드에 `runId`(실행당) 및 `sessionKey`와 함께 도착합니다. "기본" 세션은 `main` 키입니다. 없는 경우 가장 최근에 업데이트된 세션으로 돌아갑니다.
- 우선순위: 메인이 항상 승리합니다. 메인이 활성화되면 해당 상태가 즉시 표시됩니다. 기본이 유휴 상태인 경우 가장 최근에 활성화된 기본이 아닌 세션이 표시됩니다. 우리는 활동 중에 플립플롭을 하지 않습니다. 현재 세션이 유휴 상태가 되거나 기본이 활성화될 때만 전환합니다.
- 활동 종류:
  - `job`: 상위 수준 명령 실행(`state: started|streaming|done|error`).
  - `tool`: `phase: start|result`와 `toolName` 및 `meta/args`.

## IconState 열거형(Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (디버그 재정의)

### ActivityKind → 글리프

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- 기본값 → 🛠️

### 시각적 매핑

- `idle`: 일반 동물.
- `workingMain`: 문양이 있는 배지, 전체 색조, 다리 "작동" 애니메이션.
- `workingOther`: 문양이 포함된 배지, 음소거된 색조, 서둘러 없음.
- `overridden`: 활동에 관계없이 선택한 글리프/색조를 사용합니다.

## 상태 행 텍스트(메뉴)

- 작업이 활성화된 동안: `<Session role> · <activity label>`
  - 예시: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- 유휴 상태일 때: 상태 요약으로 돌아갑니다.

## 이벤트 수집

- 소스: 제어 채널 `agent` 이벤트(`ControlChannel.handleAgentEvent`).
- 구문 분석된 필드:
  - 시작/중지의 경우 `stream: "job"`를 사용하여 `data.state`를 사용합니다.
  - `stream: "tool"`는 `data.phase`, `name`, 선택 사항 `meta`/`args`입니다.
- 라벨:
  - `exec`: `args.command`의 첫 번째 줄입니다.
  - `read`/`write`: 단축 경로입니다.
  - `edit`: 경로와 `meta`/diff에서 추론된 변경 종류를 더한 개수입니다.
  - 대체: 도구 이름.

## 디버그 재정의

- 설정 ▸ 디버그 ▸ "아이콘 재정의" 선택기:
  - `System (auto)` (기본값)
  - `Working: main` (도구 종류별)
  - `Working: other` (도구 종류별)
  - `Idle`
- `@AppStorage("iconOverride")`를 통해 저장됩니다. `IconState.overridden`에 매핑되었습니다.

## 테스트 체크리스트

- 기본 세션 작업 트리거: 아이콘이 즉시 전환되고 상태 행에 기본 레이블이 표시되는지 확인합니다.
- 기본 유휴 상태에서 비기본 세션 작업을 트리거합니다. 아이콘/상태에 비기본이 표시됩니다. 끝날 때까지 안정적으로 유지됩니다.
- 다른 활성 상태에서 메인 시작: 아이콘이 즉시 메인으로 전환됩니다.
- 신속한 도구 버스트: 배지가 깜박이지 않도록 합니다(도구 결과에 대한 TTL 유예).
- 모든 세션이 유휴 상태가 되면 상태 행이 다시 나타납니다.
