# LLM Provider Cooldown System 개선 기술 문서

> **대상 독자**: MAIBOT 운영자, 기여자
> **최종 수정**: 2026-02-27
> **관련 모듈**: `src/agents/auth-profiles/`, `src/agents/model-fallback.ts`, `src/agents/failover-error.ts`

---

## 1. 문제 배경 (Problem Background)

### 1.1 OAuth 토큰 1개 운영의 연쇄 차단

단일 OAuth 토큰으로 운영할 경우, 특정 모델(예: `claude-opus-4-6`)에 대한 rate limit가 발생하면 해당 profile 전체가 cooldown에 진입했다. 같은 profile로 접근 가능한 다른 모델(`claude-sonnet-4-5` 등)까지 함께 차단되는 연쇄 효과가 발생했다.

### 1.2 5^n Backoff의 공격성

기존 backoff 공식은 `60초 * 5^(errorCount-1)`로, 지수 밑이 5였다.

| 실패 횟수 | 대기 시간 (기존 5^n) | 대기 시간 (개선 2^n) |
| --------- | -------------------- | -------------------- |
| 1회       | 1분                  | 1분                  |
| 2회       | 5분                  | 2분                  |
| 3회       | 25분                 | 4분                  |
| 4회       | 60분 (cap)           | 8분                  |
| 5회       | 60분 (cap)           | 15분 (cap)           |

3회 연속 실패 시 25분 대기는 일시적 rate limit에 비해 과도했다.

### 1.3 Timeout과 Rate Limit 동일 처리

네트워크 timeout(일시적 장애)과 HTTP 429 rate limit(사용량 초과)이 동일한 cooldown 공식에 들어갔다. Timeout은 수초 내 복구되는 경우가 많지만, rate limit과 같은 수준의 긴 대기가 적용됐다.

---

## 2. 아키텍처 변경 요약 (Architecture Changes)

### Before: 단일 Cooldown 경로

```
에러 발생
  └─> markAuthProfileCooldown()
        └─> cooldownUntil = now + 60s * 5^(n-1)   // profile 전체 차단
              └─> isProfileInCooldown() → true      // 모든 모델 차단
```

### After: 다층 Cooldown 경로

```
에러 발생
  └─> FailoverError (retryAfterMs 파싱)
        └─> markAuthProfileFailure(reason, model, retryAfterMs)
              ├─ billing  → disabledUntil (profile 전체 비활성화)
              ├─ timeout  → 30s * 2^n (max 5분, 모델별)
              ├─ rate_limit (Retry-After 있음) → min(서버값, 15분) (모델별)
              └─ rate_limit (Retry-After 없음) → 60s * 2^n (max 15분, 모델별)
                    │
                    └─> isProfileInCooldownForModel(profile, model)
                          ├─ disabledUntil 확인 → 전체 차단
                          └─> modelCooldowns[model].cooldownUntil 확인 → 해당 모델만 차단
```

---

## 3. 상세 변경사항 (Detailed Changes)

### Phase 2: Backoff 완화 (5^n --> 2^n, Timeout 분리)

**파일**: `src/agents/auth-profiles/usage.ts` -- `calculateAuthProfileCooldownMs()`

`timeout` 전용 경로를 신설하고, 기본 backoff 지수를 5에서 2로 완화했다.

```typescript
// timeout: 짧은 cooldown (일시적 장애)
if (reason === "timeout") {
  return Math.min(
    5 * 60 * 1000, // max 5분
    30 * 1000 * 2 ** Math.min(n - 1, 4), // 30초 base
  );
}

// rate_limit 등: 완화된 backoff + jitter
const base = Math.min(
  15 * 60 * 1000, // max 15분 (기존 60분)
  60 * 1000 * 2 ** Math.min(n - 1, 4), // 60초 base, 지수 2
);
const jitter = base * (0.1 + Math.random() * 0.1);
```

**Timeout Backoff 표**:

| 실패 횟수 | 대기 시간 |
| --------- | --------- |
| 1회       | 30초      |
| 2회       | 1분       |
| 3회       | 2분       |
| 4회       | 4분       |
| 5회+      | 5분 (cap) |

### Phase 3: 모델별 Cooldown (ModelCooldownEntry)

**파일**: `src/agents/auth-profiles/types.ts`, `src/agents/auth-profiles/usage.ts`

`ProfileUsageStats`에 `modelCooldowns` 필드를 추가했다. Rate limit 또는 timeout 발생 시 profile 전체가 아닌 해당 모델에만 cooldown을 기록한다.

```typescript
// types.ts
export type ModelCooldownEntry = {
  cooldownUntil?: number;
  errorCount?: number;
  lastFailureAt?: number;
};

export type ProfileUsageStats = {
  // ... 기존 필드 ...
  modelCooldowns?: Record<string, ModelCooldownEntry>;
};
```

**Cooldown 판정 함수**: `isProfileInCooldownForModel(store, profileId, model)`

| 조건                                       | 결과                                  |
| ------------------------------------------ | ------------------------------------- |
| `disabledUntil` 유효 (billing/auth)        | 모든 모델 차단                        |
| `model` 미지정                             | 기존 `isProfileInCooldown()` fallback |
| `modelCooldowns[model].cooldownUntil` 유효 | 해당 모델만 차단                      |
| 해당 모델의 cooldown 없음                  | 사용 가능                             |

### Phase 4: Retry-After 파싱 (parseRetryAfterMs)

**파일**: `src/agents/failover-error.ts`

서버가 제공하는 `Retry-After` 정보를 3가지 전략으로 추출한다.

| 전략                   | 소스                                                  | 예시                       |
| ---------------------- | ----------------------------------------------------- | -------------------------- |
| 1. HTTP headers        | `err.headers["retry-after"]` 또는 `err.headers.get()` | `"30"` (초)                |
| 2. SDK 필드            | `err.retry_after`, `err.retryAfter`                   | `30` (초, 숫자)            |
| 3. Error message regex | 메시지 내 패턴 매칭                                   | `"retry after 30 seconds"` |

파싱 실패 시 `null`을 반환하며, `err.cause` 체인까지 재귀 탐색한다. 적용 시 15분 상한(cap)을 둔다.

```typescript
// computeNextProfileUsageStats 내부
if (params.retryAfterMs && params.retryAfterMs > 0) {
  backoffMs = Math.min(params.retryAfterMs, 15 * 60 * 1000);
}
```

### Phase 5: Provider Rate Limiter

**파일**: `src/agents/provider-rate-limiter.ts`

Sliding window 기반의 proactive rate limiter. 요청 전에 RPM 한도를 확인하여 429 응답을 사전에 방지한다.

**기본 RPM 설정**:

| Provider     | 기본 RPM |
| ------------ | -------- |
| anthropic    | 50       |
| openai       | 60       |
| openai-codex | 60       |
| google       | 60       |

**API**:

| 메서드              | 설명                              |
| ------------------- | --------------------------------- |
| `consume(provider)` | 요청 허용 여부 확인 + slot 소비   |
| `peek(provider)`    | 요청 허용 여부 확인 (slot 미소비) |
| `reset(provider)`   | 특정 provider 상태 초기화         |
| `resetAll()`        | 전체 상태 초기화                  |

반환값 `ProviderRateLimitResult`는 `{ allowed, retryAfterMs, remaining }`을 포함한다.

### 보조 경로 수정

**markAuthProfileUsed** (`usage.ts:197-243`): 성공 시 `modelCooldowns`를 `undefined`로 초기화하여 모든 모델별 cooldown을 해제한다.

**clearAuthProfileCooldown** (`usage.ts:503-540`): 수동 리셋 시 `modelCooldowns`도 함께 제거한다.

**clearExpiredCooldowns** (`usage.ts:121-191`): 만료된 모델별 cooldown entry를 정리하고, 모든 cooldown이 해제되면 `errorCount`를 0으로 리셋한다(circuit breaker half-open 패턴).

**getSoonestCooldownExpiry** (`usage.ts:74-101`): 모델별 cooldown 타임스탬프도 고려하여 가장 가까운 만료 시점을 계산한다. Probe timing에 사용된다.

**run.ts profile rotation** (lines 417-460): `isProfileInCooldownForModel(store, candidate, modelId)`로 변경하여 현재 요청 모델 기준으로만 cooldown을 검사한다.

**run.ts prompt error** (lines 817-827): `markAuthProfileFailure()` 호출 시 `model`과 `retryAfterMs`를 전달한다.

**run.ts rotation path** (lines 905-921): timeout/failover 경로에서도 `model`과 `parseRetryAfterMs()` 결과를 전달한다.

## 4. 변경 파일 목록 (Files Modified)

| 파일 경로                              | 변경 요약                                                  | 주요 라인                       |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| `src/agents/auth-profiles/types.ts`    | `ModelCooldownEntry` 타입 추가, `modelCooldowns` 필드 추가 | 43-65                           |
| `src/agents/auth-profiles/usage.ts`    | 2^n backoff, timeout 분리, 모델별 cooldown 기록/판정/정리  | 전체                            |
| `src/agents/failover-error.ts`         | `retryAfterMs` 필드 추가, `parseRetryAfterMs()` 함수 신설  | 14-38, 221-285                  |
| `src/agents/model-fallback.ts`         | `isProfileInCooldownForModel()` 기반 cooldown 체크         | 310-351                         |
| `src/agents/provider-rate-limiter.ts`  | Sliding window RPM limiter (신규 파일)                     | 전체                            |
| `src/agents/pi-embedded-runner/run.ts` | model/retryAfterMs 전달, 모델별 cooldown 체크              | 7-12, 420-460, 815-830, 905-920 |

---

## 5. Before/After 비교 (Comparison)

| 항목                        | Before                           | After                            |
| --------------------------- | -------------------------------- | -------------------------------- |
| Cooldown 단위               | Profile 전체                     | 모델별 (`modelCooldowns`)        |
| Backoff 지수                | 5^n                              | 2^n                              |
| Max cooldown (rate_limit)   | 60분                             | 15분 + jitter                    |
| Max cooldown (timeout)      | 60분 (rate_limit과 동일)         | 5분 (별도 경로)                  |
| 3회 실패 대기 시간          | 25분                             | 4분 + jitter                     |
| Retry-After 사용            | 미사용                           | 서버 값 파싱, 15분 cap           |
| 모델 독립성                 | 없음 (1개 모델 차단 = 전체 차단) | 있음 (모델별 독립 cooldown)      |
| Proactive rate limiting     | 없음                             | Provider RPM limiter             |
| Cooldown 만료 후 errorCount | 유지 (즉시 재에스컬레이션)       | 리셋 (circuit breaker half-open) |

---

## 6. 설정 가이드 (Configuration)

### moltbot.json Fallback Order

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
      },
    },
  },
}
```

모델별 cooldown 도입으로, primary 모델이 rate limit에 걸려도 같은 provider의 다른 모델로 fallback이 가능하다. 동일 provider의 저비용 모델을 fallback에 포함하는 것을 권장한다.

### failureWindowHours

```jsonc
{
  "auth": {
    "cooldowns": {
      "failureWindowHours": 24,
    },
  },
}
```

`failureWindowHours` 내에 실패가 없으면 `errorCount`가 0으로 리셋된다. 기본값은 24시간이다.

### Provider Rate Limiter RPM

현재 `ProviderRateLimiter`는 코드 내 기본값을 사용한다. 설정 파일 통합은 향후 작업 대상이다.

| Provider  | 기본 RPM   | 권장 조정                 |
| --------- | ---------- | ------------------------- |
| anthropic | 50         | API tier에 따라 상향 가능 |
| openai    | 60         | 기본값 유지               |
| google    | 60         | 기본값 유지               |
| (미등록)  | 0 (무제한) | 필요 시 추가              |

---

## 7. 테스트 커버리지 (Test Coverage)

| 테스트 파일                                        | 검증 대상                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `auth-profiles.cooldown-auto-expiry.test.ts`       | `clearExpiredCooldowns()`, 모델별 cooldown 만료 정리, errorCount 리셋 |
| `auth-profiles.markauthprofilefailure.e2e.test.ts` | `markAuthProfileFailure()`, reason별 분기, 모델별 cooldown 기록       |
| `auth-profiles.getsoonestcooldownexpiry.test.ts`   | `getSoonestCooldownExpiry()`, 모델별 cooldown 포함 계산               |
| `failover-error.e2e.test.ts`                       | `FailoverError` 생성, `coerceToFailoverError()`, reason 분류          |
| `failover-error.retry-after.test.ts`               | `parseRetryAfterMs()`, headers/SDK/regex 3가지 전략                   |
| `provider-rate-limiter.test.ts`                    | `ProviderRateLimiter`, consume/peek/reset, sliding window             |
| `model-fallback.e2e.test.ts`                       | `runWithModelFallback()`, cooldown 중 skip, fallback 순서             |
| `model-fallback.probe.test.ts`                     | Primary model probe 로직, throttle key, cooldown 만료 근접 시 probe   |

---

## 8. 향후 개선 (Future Work)

### Provider Rate Limiter 통합

현재 `ProviderRateLimiter`는 독립 모듈로 존재하며 request path에 완전 통합되지 않았다. `run.ts`의 요청 전 단계에서 `consume()`을 호출하여 429 응답을 사전 차단하는 통합이 필요하다.

### 다중 OAuth 토큰 지원

동일 provider에 여러 OAuth 토큰을 등록하여 rate limit 시 즉시 전환. 모델별 cooldown과 결합 시 가용성 극대화.

### 모니터링 및 알림

- Cooldown 진입/해제 이벤트 로깅 구조화, 시간당 rate limit metrics 수집
- 반복적 billing 실패 시 운영자 알림
- `clearExpiredCooldowns()` 통계로 cooldown 효율성 측정

### Proactive Probe 개선

현재 primary model probe는 cooldown 만료 2분 전부터 30초 간격으로 시도한다. Provider별 rate limit 패턴 학습으로 probe 간격을 동적 조정하는 방안을 검토할 수 있다.
