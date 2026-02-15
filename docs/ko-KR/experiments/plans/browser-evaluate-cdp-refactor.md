---
summary: "Plan: isolate browser act:evaluate from Playwright queue using CDP, with end-to-end deadlines and safer ref resolution"
owner: "openclaw"
status: "draft"
last_updated: "2026-02-10"
title: "Browser Evaluate CDP Refactor"
x-i18n:
  source_hash: 549fe6f862b6e3466de4758a1d139cd353d9e865b2331085d8bec20e7a4bc8cd
---

# 브라우저 CDP 리팩터링 계획 평가

## 컨텍스트

`act:evaluate` 페이지에서 사용자가 제공한 JavaScript를 실행합니다. 오늘은 Playwright를 통해 진행됩니다.
(`page.evaluate` 또는 `locator.evaluate`). Playwright는 페이지당 CDP 명령을 직렬화하므로
정체되거나 장기간 실행되는 평가는 페이지 명령 대기열을 차단하고 이후의 모든 작업을 수행할 수 있습니다.
해당 탭에서 "고착"된 것으로 보입니다.

PR #13498은 실용적인 안전망(제한된 평가, 전파 중단 및 최선의 노력)을 추가합니다.
회복). 이 문서는 `act:evaluate`를 본질적으로 만드는 더 큰 리팩터링을 설명합니다.
Playwright로부터 격리되어 평가가 중단되어도 정상적인 Playwright 작업이 중단될 수 없습니다.

## 목표

- `act:evaluate`는 동일한 탭에서 이후 브라우저 작업을 영구적으로 차단할 수 없습니다.
- 시간 제한은 발신자가 예산에 의존할 수 있도록 종단 간 진실의 단일 소스입니다.
- 중단 및 시간 초과는 HTTP 및 프로세스 내 디스패치에서 동일한 방식으로 처리됩니다.
- Playwright를 끄지 않고도 평가를 위한 요소 타겟팅이 지원됩니다.
- 기존 호출자와 페이로드에 대한 이전 버전과의 호환성을 유지합니다.

## 논골

- 모든 브라우저 작업(클릭, 입력, 대기 등)을 CDP 구현으로 대체합니다.
- PR #13498에 도입된 기존 안전망을 제거합니다(유용한 대체 수단으로 남아 있음).
- 기존 `browser.evaluateEnabled` 게이트를 넘어서는 새로운 안전하지 않은 기능을 도입합니다.
- 평가를 위해 프로세스 격리(작업자 프로세스/스레드)를 추가합니다. 아직도 회복하기 힘든 모습을 보인다면
  이 리팩터링 이후 상태가 중단되었습니다. 이는 후속 아이디어입니다.

## 현재 아키텍처(멈추는 이유)

높은 수준에서:

- 발신자는 브라우저 제어 서비스에 `act:evaluate`를 보냅니다.
- 경로 핸들러는 JavaScript를 실행하기 위해 Playwright를 호출합니다.
- 극작가는 페이지 명령을 직렬화하므로 완료되지 않는 평가는 대기열을 차단합니다.
- 대기열 중단은 나중에 탭의 클릭/입력/대기 작업이 중단된 것처럼 보일 수 있음을 의미합니다.

## 제안된 아키텍처

### 1. 마감일 전파

단일 예산 개념을 도입하고 그로부터 모든 것을 도출합니다.

- 발신자는 `timeoutMs`(또는 향후 마감일)을 설정합니다.
- 외부 요청 시간 초과, 경로 처리기 논리 및 페이지 내부 실행 예산
  모두 동일한 예산을 사용하며 직렬화 오버헤드에 필요한 작은 헤드룸을 사용합니다.
- 중단은 `AbortSignal`로 모든 곳에서 전파되므로 취소가 일관됩니다.

구현 방향:

- 다음을 반환하는 작은 도우미(예: `createBudget({ timeoutMs, signal })`)를 추가합니다.
  - `signal`: 연결된 AbortSignal
  - `deadlineAtMs`: 절대 기한
  - `remainingMs()` : 하위 작업에 남은 예산
- 이 도우미를 다음과 같은 용도로 사용하세요.
  - `src/browser/client-fetch.ts` (HTTP 및 진행 중인 디스패치)
  - `src/node-host/runner.ts` (프록시 경로)
  - 브라우저 액션 구현(Playwright 및 CDP)

### 2. 별도의 평가 엔진(CDP 경로)

Playwright의 페이지별 명령을 공유하지 않는 CDP 기반 평가 구현을 추가하세요.
대기열. 주요 속성은 평가 전송이 별도의 WebSocket 연결입니다.
타겟에 별도의 CDP 세션이 연결됩니다.

구현 방향:

- 새 모듈(예: `src/browser/cdp-evaluate.ts`):
  - 구성된 CDP 엔드포인트(브라우저 수준 소켓)에 연결합니다.
  - `Target.attachToTarget({ targetId, flatten: true })`를 사용하여 `sessionId`를 얻습니다.
  - 다음 중 하나를 실행합니다.
    - 페이지 수준 평가의 경우 `Runtime.evaluate` 또는
    - `DOM.resolveNode` + `Runtime.callFunctionOn` 요소 평가.
  - 시간 초과 또는 중단 시:
    - 세션을 위해 `Runtime.terminateExecution` 최선의 노력을 보냅니다.
    - WebSocket을 닫고 명확한 오류를 반환합니다.

참고:

- 이는 여전히 페이지에서 JavaScript를 실행하므로 종료 시 부작용이 발생할 수 있습니다. 승리
  극작가 대기열을 방해하지 않으며 전송 시 취소할 수 있습니다.
  CDP 세션을 종료하여 레이어를 삭제합니다.

### 3. Ref Story(전체 재작성 없이 요소 타겟팅)

어려운 부분은 요소 타겟팅입니다. CDP에는 DOM 핸들 또는 `backendDOMNodeId`가 필요합니다.
오늘날 대부분의 브라우저 작업은 스냅샷의 참조를 기반으로 하는 Playwright 로케이터를 사용합니다.

권장 접근 방식: 기존 참조를 유지하되 선택적 CDP 확인 가능 ID를 연결하세요.

#### 3.1 저장된 참조 정보 확장

선택적으로 CDP ID를 포함하도록 저장된 역할 참조 메타데이터를 확장합니다.

- 오늘: `{ role, name, nth }`
- 제안: `{ role, name, nth, backendDOMNodeId?: number }`

이렇게 하면 기존 극작가 기반 작업이 모두 계속 작동하고 CDP 평가에서 수락할 수 있습니다.
`backendDOMNodeId`를 사용할 수 있는 경우 동일한 `ref` 값입니다.

#### 3.2 스냅샷 시 backendDOMNodeId 채우기

역할 스냅샷을 생성할 때:

1. 오늘(역할, 이름, n번째)로 기존 역할 참조 맵을 생성합니다.
2. CDP(`Accessibility.getFullAXTree`)를 통해 AX 트리를 가져오고 다음의 병렬 맵을 계산합니다.
   `(role, name, nth) -> backendDOMNodeId` 동일한 중복 처리 규칙을 사용합니다.
3. 현재 탭에 대해 저장된 참조 정보에 ID를 다시 병합합니다.

참조에 대한 매핑이 실패하면 `backendDOMNodeId`를 정의되지 않은 상태로 둡니다. 이렇게 하면 기능이
최선의 노력을 다하고 안전하게 출시할 수 있습니다.

#### 3.3 Ref를 사용하여 동작 평가

`act:evaluate`에서:

- `ref`가 존재하고 `backendDOMNodeId`가 있는 경우 CDP를 통해 요소 평가를 실행합니다.
- `ref`가 있지만 `backendDOMNodeId`가 없으면 극작가 경로로 폴백합니다(
  안전망).

선택적 탈출구:

- 고급 발신자를 위해 `backendDOMNodeId`를 직접 수락하도록 요청 형태를 확장합니다.
  디버깅용), `ref`을 기본 인터페이스로 유지합니다.

### 4. 최후의 수단으로 복구 경로를 유지하세요.

CDP 평가를 사용하더라도 탭이나 연결을 고정하는 다른 방법이 있습니다. 유지
최후의 수단으로 기존 복구 메커니즘(실행 종료 + Playwright 연결 끊기)
대상:

- 레거시 발신자
- CDP 연결이 차단된 환경
- 예상치 못한 극작가의 경우

## 구현 계획(단일 반복)

### 결과물

- Playwright 페이지별 명령 대기열 외부에서 실행되는 CDP 기반 평가 엔진입니다.
- 호출자와 핸들러가 일관되게 사용하는 단일 종단 간 시간 초과/중단 예산입니다.
- 요소 평가를 위해 선택적으로 `backendDOMNodeId`를 전달할 수 있는 참조 메타데이터입니다.
- `act:evaluate`는 가능하면 CDP 엔진을 선호하고 그렇지 않으면 Playwright로 대체합니다.
- 평가가 중단되었음을 입증하는 테스트는 이후 작업에 영향을 주지 않습니다.
- 실패 및 대체를 표시하는 로그/메트릭입니다.

### 구현 체크리스트

1. `timeoutMs` + 업스트림 `AbortSignal`을 연결하기 위한 공유 "예산" 도우미를 추가합니다.
   - 단일 `AbortSignal`
   - 절대 기한
   - 다운스트림 작업을 위한 `remainingMs()` 도우미
2. 해당 도우미를 사용하도록 모든 호출자 경로를 업데이트하여 `timeoutMs`는 모든 곳에서 동일한 것을 의미합니다.
   - `src/browser/client-fetch.ts` (HTTP 및 진행 중인 디스패치)
   - `src/node-host/runner.ts` (노드 프록시 경로)
   - `/act`를 호출하는 CLI 래퍼(`browser evaluate`에 `--timeout-ms` 추가)
3. `src/browser/cdp-evaluate.ts` 구현:
   - 브라우저 수준 CDP 소켓에 연결
   - `Target.attachToTarget`를 얻으려면 `sessionId`를 얻습니다.
   - 페이지 평가를 위해 `Runtime.evaluate`를 실행합니다.
   - 요소 평가를 위해 `DOM.resolveNode` + `Runtime.callFunctionOn`를 실행합니다.
   - 시간 초과/중단 시: 최선의 노력 `Runtime.terminateExecution` 후 소켓을 닫습니다.
4. `backendDOMNodeId`를 선택적으로 포함하도록 저장된 역할 참조 메타데이터를 확장합니다.
   - 극작가 작업에 대한 기존 `{ role, name, nth }` 동작을 유지합니다.
   - CDP 요소 타겟팅을 위해 `backendDOMNodeId?: number`를 추가합니다.
5. 스냅샷 생성 중에 `backendDOMNodeId`를 입력합니다(최선을 다해):
   - CDP를 통해 AX 트리 가져오기 (`Accessibility.getFullAXTree`)
   - `(role, name, nth) -> backendDOMNodeId`를 계산하고 저장된 참조 맵에 병합합니다.
   - 매핑이 모호하거나 누락된 경우 ID를 정의되지 않은 상태로 둡니다.
6. `act:evaluate` 라우팅 업데이트:
   - 그렇지 않은 경우 `ref`: 항상 CDP 평가를 사용합니다.
   - `ref`가 `backendDOMNodeId`로 해석되는 경우: CDP 요소 평가를 사용합니다.
   - 그렇지 않은 경우: Playwright 평가로 대체(여전히 제한되어 있고 중단 가능)
7. 기본 경로가 아닌 기존 "최후의 수단" 복구 경로를 대체 수단으로 유지합니다.
8. 테스트를 추가합니다.
   - 예산 내에서 평가 시간이 초과되어 다음 클릭/유형이 성공했습니다.
   - abort는 평가(클라이언트 연결 끊기 또는 시간 초과)를 취소하고 후속 작업 차단을 해제합니다.
   - 매핑 실패는 극작가에게 완전히 돌아갑니다.
9. 관찰 가능성을 추가합니다.
   - 기간 및 시간 초과 카운터를 평가합니다.
   - 종료실행 사용법
   - 대체율(CDP -> 극작가) 및 이유

### 승인 기준

- 의도적으로 중단된 `act:evaluate`는 호출자 예산 내에서 반환되며
  나중 작업을 위한 탭입니다.
- `timeoutMs`는 CLI, 에이전트 도구, 노드 프록시 및 진행 중인 호출 전반에서 일관되게 작동합니다.
- `ref`가 `backendDOMNodeId`에 매핑될 수 있는 경우 요소 평가는 CDP를 사용합니다. 그렇지 않으면
  대체 경로는 여전히 제한되어 있으며 복구 가능합니다.

## 테스트 계획

- 단위 테스트:
  - `(role, name, nth)` 역할 참조와 AX 트리 노드 간의 논리 일치.
  - 예산 도우미 행동(헤드룸, 남은 시간 계산).
- 통합 테스트:
  - CDP는 예산 내에서 시간 초과 반환을 평가하고 다음 작업을 차단하지 않습니다.
  - 중단은 평가를 취소하고 최선의 종료를 트리거합니다.
- 계약 테스트:
  - `BrowserActRequest`와 `BrowserActResponse`가 호환되는지 확인하세요.

## 위험 및 완화

- 매핑이 불완전합니다.
  - 완화: 최선의 매핑, Playwright 평가로의 대체, 디버그 도구 추가.
- `Runtime.terminateExecution`에는 부작용이 있습니다.
  - 완화: 시간 초과/중단 시에만 사용하고 오류 발생 시 동작을 문서화합니다.
- 추가 간접비:
  - 완화: 스냅샷이 요청될 때만 AX 트리를 가져오고, 대상별로 캐시하고, 유지합니다.
    CDP 세션은 수명이 짧습니다.
- 확장 릴레이 제한사항:
  - 완화: 페이지당 소켓을 사용할 수 없는 경우 브라우저 수준 연결 API를 사용합니다.
    현재 극작가 경로를 대체 경로로 유지합니다.

## 공개 질문

- 새 엔진을 `playwright`, `cdp` 또는 `auto`로 구성할 수 있어야 합니까?
- 고급 사용자를 위해 새로운 "nodeRef" 형식을 공개하시겠습니까, 아니면 `ref`만 유지하시겠습니까?
- 프레임 스냅샷과 선택기 범위 스냅샷은 AX 매핑에 어떻게 참여해야 합니까?
