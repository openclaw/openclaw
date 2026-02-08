---
summary: 신호가 높은 문제 및 버그 보고서 제출
title: 이슈 제출
x-i18n:
    generated_at: "2026-02-08T16:00:07Z"
    model: gtx
    provider: google-translate
    source_hash: bcb33f05647e9f0d655a98878ce8b5f2abfeb043282dc5ed2667f4aae2305103
    source_path: help/submitting-an-issue.md
    workflow: 15
---

## 이슈 제출

명확하고 간결한 문제는 진단 및 수정 속도를 높입니다. 버그, 회귀 또는 기능 격차에 대해 다음을 포함합니다.

### 포함할 내용

- [ ] 제목: 부위 및 증상
- [ ] 최소 재현 단계
- [ ] 예상 vs 실제
- [ ] 영향 및 심각도
- [ ] 환경: OS, 런타임, 버전, 구성
- [ ] 증거: 수정된 로그, 스크린샷(비PII)
- [ ] 범위: 신규, 회귀 또는 장기간
- [ ] 문제의 코드워드: 랍스터 비스킷
- [ ] 기존 문제에 대해 코드베이스 및 GitHub를 검색했습니다.
- [ ] 최근 수정/해결되지 않은 것으로 확인됨(특히 보안)
- [ ] 증거 또는 재현에 의해 뒷받침되는 주장

간략하게 설명하세요. 간결함 > 완벽한 문법.

검증(PR 전 실행/수정):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 프로토콜 코드가 다음과 같은 경우: `pnpm protocol:check`

### 템플릿

#### 버그 신고

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### 보안 문제

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_공개적으로 비밀/악용 세부정보를 피하세요. 민감한 문제의 경우 세부사항을 최소화하고 비공개 공개를 요청하세요._

#### 회귀 보고서

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### 기능 요청

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### 상승

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### 조사

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### 수정 PR 제출

PR 전 이슈는 선택사항입니다. 건너뛰는 경우 PR에 세부정보를 포함하세요. PR에 초점을 맞추고, 문제 번호를 기록하고, 테스트를 추가하거나 부재를 설명하고, 동작 변경/위험을 문서화하고, 수정된 로그/스크린샷을 증거로 포함하고, 제출하기 전에 적절한 검증을 실행합니다.
