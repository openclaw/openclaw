---
summary: "계획: CDP를 사용하여 act:evaluate 브라우저를 Playwright 큐에서 격리하고, 엔드 투 엔드 데드라인과 안전한 참조 해결을 보장합니다."
owner: "openclaw"
status: "초안"
last_updated: "2026-02-10"
title: "브라우저 Evaluate CDP 리팩터"
---

# 브라우저 Evaluate CDP 리팩터 계획

## 컨텍스트

`act:evaluate`는 페이지에서 사용자가 제공하는 JavaScript를 실행합니다. 현재는 Playwright
(`page.evaluate` 또는 `locator.evaluate`)를 통해 실행됩니다. Playwright는 페이지별로 CDP 명령어를 직렬화하므로
멈추거나 오래 실행되는 평가가 페이지 명령 큐를 막아 해당 탭에서 이후 모든 작업을 "멈춘" 것처럼 보이게 할 수 있습니다.

PR #13498는 실용적인 안전망 (제한된 평가, 중단 전파, 최선의 회복)을 추가합니다. 이 문서는 Playwright에서 `act:evaluate`를 본질적으로 격리하여
멈춘 평가가 일반 Playwright 작업을 방해할 수 없게 하는 더 큰 리팩터를 설명합니다.

## 목표

- `act:evaluate`가 같은 탭에서 나중에 브라우저 작업을 영구적으로 막을 수 없어야 합니다.
- 타임아웃은 처음부터 끝까지 단일 진리 원천이 되어 호출자가 예산에 의존할 수 있게 해야 합니다.
- 중단 및 타임아웃은 HTTP 및 프로세스 내 배포에서 동일한 방식으로 처리됩니다.
- 평가를 위한 요소 타겟팅은 모든 것을 Playwright에서 전환하지 않고 지원되어야 합니다.
- 기존 호출자 및 페이로드와의 하위 호환성을 유지해야 합니다.

## 비목표

- 모든 브라우저 작업(클릭, 입력, 대기 등)을 CDP 구현으로 대체하지 마십시오.
- PR #13498에 도입된 기존 안전망을 제거하지 마십시오 (유용한 대체로 남겨두십시오).
- 기존 `browser.evaluateEnabled` 게이트를 넘어 새로운 위험한 기능을 도입하지 마십시오.
- 평가를 위한 프로세스 격리 (워크 프로세스/스레드)를 추가하지 마십시오. 이 리팩터 후에도 복구하기 어려운 멈춘 상태가 계속해서 발생한다면, 이는 추후 고려 사항입니다.

## 현재 아키텍처 (왜 멈추는가)

고수준에서:

- 호출자는 `act:evaluate`를 브라우저 제어 서비스로 보냅니다.
- 경로 핸들러는 Playwright에 JavaScript 실행을 호출합니다.
- Playwright는 페이지 명령어를 직렬화하므로, 종료되지 않는 평가는 큐를 막습니다.
- 멈춘 큐는 탭에서 후속 클릭/입력/대기 작업이 멈춘 것처럼 보이게 할 수 있습니다.

## 제안된 아키텍처

### 1. 데드라인 전파

단일 예산 개념을 도입하고 이를 기반으로 모든 것을 유도합니다:

- 호출자는 `timeoutMs` (또는 미래의 데드라인)를 설정합니다.
- 외부 요청 타임아웃, 경로 핸들러 로직 및 페이지 내부 실행 예산 모두에 동일한 예산을 사용하며, 직렬화 오버헤드를 위한 약간의 여유를 둡니다.
- 중단은 `AbortSignal`로 도처에 전파되어 취소가 일관성 있게 됩니다.

구현 방향:

- 작은 도우미 (예: `createBudget({ timeoutMs, signal })`)를 추가하여 다음을 반환합니다:
  - `signal`: 연결된 AbortSignal
  - `deadlineAtMs`: 절대 데드라인
  - `remainingMs()`: 하위 작업에 대한 남은 예산
- 이 도우미를 다음에서 사용합니다:
  - `src/browser/client-fetch.ts` (HTTP 및 프로세스 내 배포)
  - `src/node-host/runner.ts` (프록시 경로)
  - 브라우저 작업 구현 (Playwright 및 CDP)

### 2. 별도의 평가 엔진 (CDP 경로)

Playwright의 페이지별 명령 큐와 공유하지 않는 CDP 기반 평가 구현을 추가합니다. 주요 속성은 평가 전송이 별도의 WebSocket 연결 및 대상에 연결된 별도의 CDP 세션이라는 것입니다.

구현 방향:

- 새 모듈, 예를 들어 `src/browser/cdp-evaluate.ts`, 다음을 수행합니다:
  - 구성된 CDP 엔드포인트에 연결합니다 (브라우저 수준 소켓).
  - `Target.attachToTarget({ targetId, flatten: true })`를 사용하여 `sessionId`를 수신합니다.
  - 다음 중 하나를 실행합니다:
    - 페이지 수준 평가를 위한 `Runtime.evaluate`, 또는
    - 요소 평가를 위한 `DOM.resolveNode`와 `Runtime.callFunctionOn`.
  - 타임아웃 또는 중단 시:
    - 최선의 노력으로 `Runtime.terminateExecution`을 세션에 대해 보냅니다.
    - WebSocket을 닫고 명확한 오류를 반환합니다.

메모:

- 여전히 페이지에서 JavaScript를 실행하므로 종료는 부작용을 가질 수 있습니다. 장점은 Playwright 큐를 막지 않고, CDP 세션을 종료하여 전송 레이어에서 취소 가능합니다.

### 3. 참조 스토리 (전체 재작성 없이 요소 타겟팅)

가장 어려운 부분은 요소 타겟팅입니다. CDP는 DOM 핸들이나 `backendDOMNodeId`가 필요하며, 현재 대부분의 브라우저 작업은 스냅샷에서 Playwright 로케이터 기반 참조를 사용합니다.

추천 접근법: 기존 참조를 유지하되, 선택적으로 CDP에서 해결 가능한 id를 첨부하십시오.

#### 3.1 저장된 참조 정보 확장

저장된 역할 참조 메타데이터를 확장하여 선택적으로 CDP id를 포함합니다:

- 현재: `{ role, name, nth }`
- 제안된: `{ role, name, nth, backendDOMNodeId?: number }`

이는 모든 기존 Playwright 기반 작업을 작업하게 하고 CDP 평가가 `ref` 값을 통해 `backendDOMNodeId`가 있을 때 수락할 수 있게 합니다.

#### 3.2 스냅샷시 `backendDOMNodeId` 채우기

역할 스냅샷 생성 시:

1. 현재와 동일하게 기존 역할 참조 맵을 생성합니다 (역할, 이름, n번째).
2. CDP를 통해 AX 트리를 가져오고 (`Accessibility.getFullAXTree`), 동일한 중복 처리 규칙을 사용하여 `(role, name, nth) -> backendDOMNodeId`의 병렬 맵을 계산합니다.
3. 이 id를 현재 탭의 저장된 참조 정보에 다시 병합합니다.

참조 매핑이 실패하면, `backendDOMNodeId`를 정의되지 않은 상태로 남겨둡니다. 이는 기능을 최선의 노력으로 만들고 안전하게 롤아웃할 수 있게 합니다.

#### 3.3 참조 평가 동작

`act:evaluate`에서:

- `ref`가 있고 `backendDOMNodeId`가 있으면, CDP를 통해 요소 평가를 실행하십시오.
- `ref`가 있지만 `backendDOMNodeId`가 없으면, Playwright 경로로 복귀하십시오 (안전망과 함께).

선택적 이스케이프 해치:

- 고급 호출자(및 디버깅)를 위해 요청 형식을 직접 `backendDOMNodeId`를 수락하도록 확장하십시오, 주요 인터페이스로 `ref`를 유지합니다.

### 4. 마지막 수단 회복 경로 유지하기

심지어 CDP 평가를 사용하면서도 다른 방법으로 탭이나 연결을 방해할 수 있습니다. 기존 회복 메커니즘 (실행 종료 + Playwright 연결 해제)을 보조 도구로 사용하십시오:

- 레거시 호출자
- CDP 연결이 차단된 환경
- 예기치 않은 Playwright 가장자리 사례

## 구현 계획 (단일 반복)

### 산출물

- Playwright 페이지별 명령 큐 외부에서 실행되는 CDP 기반 평가 엔진.
- 호출자와 핸들러가 일관되게 사용하는 단일 엔드 투 엔드 타임아웃/중단 예산.
- `backendDOMNodeId`를 요소 평가를 위해 선택적으로 포함할 수 있는 참조 메타데이터.
- `act:evaluate`는 가능할 때 CDP 엔진을 선호하며, 그렇지 않을 경우 Playwright로 복귀합니다.
- 멈춘 평가가 이후 작업을 방해하지 않는지 입증하는 테스트.
- 실패 및 대체를 가시화하는 로그/메트릭.

### 구현 체크리스트

1. 공유 "예산" 도우미를 추가하여 `timeoutMs` + 상위 `AbortSignal`을 하나의 `AbortSignal`로 연결합니다:
   - 하나의 `AbortSignal`
   - 절대 데드라인
   - 하위 작업을 위한 `remainingMs()` 도우미
2. 모든 호출자 경로가 해당 도우미를 사용하여 `timeoutMs`가 어디서나 동일하게 작동하도록 업데이트:
   - `src/browser/client-fetch.ts` (HTTP 및 프로세스 내 배포)
   - `src/node-host/runner.ts` (노드 프로토콜 경로)
   - `/act`를 호출하는 CLI 래퍼 (명령어에 `--timeout-ms` 추가)
3. `src/browser/cdp-evaluate.ts` 구현:
   - 브라우저 수준 CDP 소켓에 연결
   - `Target.attachToTarget`를 사용하여 `sessionId` 얻기
   - 페이지 평가를 위한 `Runtime.evaluate` 실행
   - 요소 평가를 위한 `DOM.resolveNode` + `Runtime.callFunctionOn` 실행
   - 타임아웃/중단 시: 최선의 노력으로 `Runtime.terminateExecution` 그런 후 소켓 닫기
4. 저장된 역할 참조 메타데이터를 확장하여 선택적으로 `backendDOMNodeId` 포함:
   - Playwright 작업을 위한 기존 `{ role, name, nth }` 동작 유지
   - CDP 요소 타겟팅을 위한 `backendDOMNodeId?: number` 추가
5. 스냅샷 생성 중 `backendDOMNodeId` 채우기 (최선의 노력):
   - CDP를 통해 AX 트리 가져오기 (`Accessibility.getFullAXTree`)
   - `(role, name, nth) -> backendDOMNodeId`를 계산하고 저장된 참조 맵에 병합
   - 매핑이 불명확하거나 누락되면, id를 정의하지 않은 상태로 두기
6. `act:evaluate` 경로 업데이트:
   - `ref`가 없으면: 항상 CDP 평가 사용
   - `ref`가 `backendDOMNodeId`로 해결되면: CDP 요소 평가 사용
   - 그렇지 않으면: Playwright 평가로 복귀 (여전히 제한되고 중단 가능)
7. 기본 경로가 아닌, 기존의 "마지막 수단" 회복 경로 유지.
8. 테스트 추가:
   - 멈춘 평가가 예산 내에서 타임아웃되고, 다음 클릭/입력이 성공함
   - 중단이 평가를 취소하고 (클라이언트 연결 끊기 또는 타임아웃) 후속 작업을 해체함
   - 매핑 실패가 Playwright로 깨끗하게 복귀함
9. 가시성 추가:
   - 평가 시간 및 타임아웃 카운터
   - `terminateExecution` 사용
   - 대체 비율 (CDP -> Playwright) 및 이유

### 수용 기준

- 의도적으로 멈춘 `act:evaluate`가 호출자 예산 내에서 반환되고, 이후 작업을 위해 탭을 방해하지 않음.
- `timeoutMs`가 CLI, 에이전트 도구, 노드 프록시, 프로세스 내 호출 전반에 걸쳐 일관되게 작동.
- `ref`가 `backendDOMNodeId`로 매핑될 수 있으면, 요소 평가가 CDP를 사용; 그렇지 않으면 여전히 제한되고 복구 가능한 대체 경로.

## 테스트 계획

- 단위 테스트:
  - 역할 참조와 AX 트리 노드 간의 `(role, name, nth)` 매칭 로직.
  - 예산 도우미 동작 (헤드룸, 남은 시간 계산).
- 통합 테스트:
  - CDP 평가 타임아웃이 예산 내에서 반환되고 다음 작업을 막지 않음.
  - 중단이 평가를 취소하고, 종료 최선의 노력을 트리거함.
- 계약 테스트:
  - `BrowserActRequest` 및 `BrowserActResponse`가 호환성을 유지하는지 확인.

## 위험 및 완화

- 매핑이 불완전 합니다:
  - 완화책: 최선의 노력으로 매핑, Playwright 평가로의 대체, 디버깅 도구 추가.
- `Runtime.terminateExecution`이 부작용을 가집니다:
  - 완화책: 타임아웃/중단시에만 사용하고 오류에 해당 동작을 문서화.
- 추가 오버헤드가 발생합니다:
  - 완화책: 스냅샷 요청 시에만 AX 트리를 가져오며, 타겟별로 캐시, CDP 세션을 단기간으로 유지.
- 확장 릴레이 제한사항:
  - 완화책: 페이지별 소켓이 사용 가능하지 않을 때 브라우저 수준의 첨부 API를 사용하고, 현재 Playwright 경로를 대체 경로로 유지.

## 열린 질문

- 새로운 엔진이 `playwright`, `cdp` 또는 `auto`로 설정 가능해야 할까요?
- 고급 사용자에게 새로운 "nodeRef" 형식을 노출할지, 또는 `ref`만 유지할까요?
- 프레임 스냅샷과 선택자 스코핑 스냅샷이 AX 매핑에 어떻게 참여할까요?