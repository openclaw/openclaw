# Ouroboros Resilience

Ouroboros Phase 3 — 4가지 정체 패턴 감지 + 5가지 사고 페르소나로 에이전트 stuck 상태를 탈출.

## 기존 stagnation 감지와의 관계

기존 `task-self-driving.ts`의 감지:

- **stalled_step**: 같은 step에서 3회 연속 멈춤 → 에스컬레이션
- **zero_progress**: 5회 연속 진행 없음 → 에스컬레이션

Ouroboros resilience는 이를 **대체하지 않고 보완**:

- `task-self-driving.ts`: step 레벨 감지 (빠름, 동기적)
- `ouroboros-resilience.ts`: output 해시 기반 패턴 감지 (정교함, continuation runner에서 동작)

## 4가지 정체 패턴

### 1. Spinning (반복)

동일한 출력을 3회 이상 반복. 에이전트가 같은 작업을 무한 반복하는 상태.

- **감지**: 최근 3개 output 해시가 동일
- **신뢰도**: 0.95

### 2. Oscillation (진동)

A-B-A-B 패턴으로 두 상태 사이를 오가는 상태.

- **감지**: 최근 4개 해시에서 `hash[0]==hash[2] && hash[1]==hash[3] && hash[0]!=hash[1]`
- **신뢰도**: 0.90

### 3. No Drift (정체)

출력이 미세하게 변하지만 실질적 진전이 없는 상태.

- **감지**: 최근 4개 drift 점수 평균 < 0.05
- **신뢰도**: 0.80

### 4. Diminishing Returns (수확 체감)

초기에는 진전이 있었으나 점점 변화가 줄어드는 상태.

- **감지**: 최근 4개 drift 중 마지막이 처음의 30% 미만
- **신뢰도**: 0.75

## 5가지 사고 페르소나

각 페르소나는 다른 관점에서 문제에 접근하도록 프롬프트를 주입.

### Hacker

관습적 접근을 벗어나 워크어라운드, 해킹, 최소 변경으로 돌파.

### Researcher

체계적으로 분석. 에러 메시지 재해석, 가설 검증, 문서 검색.

### Simplifier

현재 접근이 너무 복잡. 더 단순한 방법, 코드 삭제, 최소 구현.

### Architect

설계 재검토. 태스크 분해 재조정, 추상화 수준 변경, 인터페이스 재설계.

### Contrarian

모든 가정에 도전. 반대 접근, 요구사항 유연성, "에러가 정상인가?"

## 패턴 → 페르소나 매핑

| 패턴                | 우선 페르소나                       |
| ------------------- | ----------------------------------- |
| spinning            | hacker → contrarian → simplifier    |
| oscillation         | architect → researcher → simplifier |
| no_drift            | contrarian → hacker → researcher    |
| diminishing_returns | simplifier → architect → contrarian |

우선 페르소나 소진 후 나머지 페르소나를 순서대로 시도. 5가지 모두 소진 시 기존 에스컬레이션 로직으로 fallback.

## 동작 흐름

1. Continuation runner가 idle 태스크에 continuation 전송 직전에 호출
2. 태스크의 progress + lastActivity를 해시하여 `ouroborosHistory.outputHashes`에 추가
3. 이전 해시와의 drift를 계산하여 `driftScores`에 추가
4. `detectStagnation()` 호출 → 패턴 감지
5. 패턴 감지 시 `selectPersona()` → 미사용 페르소나 선택
6. 페르소나 프롬프트를 continuation 프롬프트에 append
7. 사용된 페르소나를 `appliedPersonas`에 기록
8. 히스토리는 TaskFile의 `ouroborosHistory` 필드에 저장 (최대 20개 유지)

## 디버깅

### 로그에서 정체 감지 확인

```
grep "Ouroboros resilience triggered" logs/
```

### 로그에서 페르소나 전환 확인

```
grep "Ouroboros persona injected" logs/
```

### 로그 필드

- `pattern`: 감지된 정체 패턴
- `confidence`: 감지 신뢰도
- `persona`: 주입된 페르소나
- `details`: 감지 상세 설명

### 페르소나 소진 확인

```
grep "all personas exhausted" logs/
```

## 관련 파일

- `src/infra/ouroboros-resilience.ts` — 4패턴 감지 + 5페르소나 (순수 함수)
- `src/infra/task-continuation-runner.ts` — resilience 통합 지점
- `src/infra/task-self-driving.ts` — 기존 stagnation 감지 (공존)
- `src/agents/tools/task-file-io.ts` — `ouroborosHistory` 필드 정의
