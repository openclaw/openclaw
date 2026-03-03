# #7 A2A 에이전트별 동시성 제한 — 구현 기록

> **구현일**: 2026-02-19
> **상태**: 완료 (Phase 1-2)
> **설계 문서**: [07-a2a-concurrency-control.md](./07-a2a-concurrency-control.md)

---

## 1. 구현 요약

에이전트별 A2A 동시 플로우 세마포어를 구현하고 A2A ping-pong 플로우에 통합했다.

### 핵심 모듈

| 모듈                      | LOC | 책임                                        |
| ------------------------- | --- | ------------------------------------------- |
| `a2a-concurrency.ts`      | 156 | A2AConcurrencyGateImpl 클래스 + 모듈 싱글톤 |
| `a2a-concurrency.test.ts` | 161 | 14개 단위 테스트                            |

## 2. 변경된 파일 목록

### 신규 생성

- `src/agents/a2a-concurrency.ts` — 세마포어 구현, 인터페이스, 에러 클래스, 싱글톤
- `src/agents/a2a-concurrency.test.ts` — 14개 단위 테스트

### 수정

- `src/agents/tools/sessions-send-tool.a2a.ts` — `runSessionsSendA2AFlow()`에 acquire/release 추가
- `src/gateway/server-startup.ts` — `initA2AConcurrencyGate()` 호출 추가

## 3. 동작 방식

- `startGatewaySidecars()` 실행 시 `initA2AConcurrencyGate()` 호출로 전역 게이트 초기화
- `runSessionsSendA2AFlow()` 진입 시 `getA2AConcurrencyGate()?.acquire(toAgent, conversationId)` 호출
- 플로우 완료/에러 시 `finally` 블록에서 `release()` 호출
- 게이트 미초기화 시 (null) 기존 동작과 동일 (제한 없음)

### 기본값

- `maxConcurrentFlows`: 3 (에이전트당 최대 동시 A2A 플로우)
- `queueTimeoutMs`: 30,000ms (대기 타임아웃)

## 4. 테스트 결과

| 테스트                           | 결과                                  |
| -------------------------------- | ------------------------------------- |
| `a2a-concurrency.test.ts`        | ✅ 14 tests pass                      |
| `pnpm build`                     | ✅ 성공                               |
| `sessions-send-tool.a2a.test.ts` | 6 pre-existing failures (변경과 무관) |

## 5. 운영 영향

- 기본 `maxConcurrentFlows: 3`은 대부분 환경에서 충분
- 게이트 미초기화 시 무제한 동작 (역호환)
- 프로세스 재시작 시 메모리 Map 초기화로 자동 해소

## Follow-up: Per-Agent Config Schema (2026-02-19)

### 변경 파일

| 파일                                                   | 변경 유형 | 설명                                           |
| ------------------------------------------------------ | --------- | ---------------------------------------------- |
| `src/config/types.agent-defaults.ts`                   | 수정      | `a2aConcurrency` 필드 추가                     |
| `src/config/agent-limits.ts`                           | 수정      | `resolveA2AConcurrencyConfig()` 함수 추가      |
| `src/gateway/server-startup.ts`                        | 수정      | `initA2AConcurrencyGate()` 호출 시 config 전달 |
| `src/config/config.agent-concurrency-defaults.test.ts` | 수정      | 7개 테스트 추가                                |

### 설정 스키마

```yaml
# openclaw.json
agents:
  defaults:
    a2aConcurrency:
      maxConcurrentFlows: 5 # Default: 3 (per agent)
      queueTimeoutMs: 60000 # Default: 30000 (ms)
```

### Resolver 로직

- `maxConcurrentFlows`: 최소 1, 정수로 내림, 기본값 3
- `queueTimeoutMs`: 최소 1000ms, 정수로 내림, 기본값 30000ms
- 비숫자/NaN/undefined → 기본값 사용

### 검증

- TypeScript `--noEmit` 에러 없음
- 11 tests 전체 통과 (4 기존 + 7 신규)
