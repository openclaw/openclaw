---
summary: "신호가 높은 이슈 및 버그 리포트 제출"
title: "이슈 제출"
---

## 이슈 제출

명확하고 간결한 이슈는 진단과 수정 속도를 높입니다. 버그, 회귀, 기능 격차의 경우 다음을 포함하십시오.

### 포함할 내용

- [ ] 제목: 영역 & 증상
- [ ] 최소 재현 단계
- [ ] 기대 결과 vs 실제 결과
- [ ] 영향 & 심각도
- [ ] 환경: OS, 런타임, 버전, 설정
- [ ] 증거: 마스킹된 로그, 스크린샷 (비 PII)
- [ ] 범위: 신규, 회귀, 또는 장기적 이슈
- [ ] 코드 워드: 이슈에 lobster-biscuit 포함
- [ ] 기존 이슈 여부를 코드베이스 & GitHub 에서 검색
- [ ] 최근에 수정/해결되지 않았음을 확인 (특히 보안)
- [ ] 주장에는 증거 또는 재현 제공

간결하게 작성하십시오. 완벽한 문법보다 간결함이 우선입니다.

검증 (PR 전에 실행/수정):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 프로토콜 코드인 경우: `pnpm protocol:check`

### 템플릿

#### 버그 리포트

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

#### 보안 이슈

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_공개 공간에는 비밀 정보/익스플로잇 세부 사항을 피하십시오. 민감한 이슈의 경우 세부 내용을 최소화하고 비공개 공개를 요청하십시오._

#### 회귀 리포트

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

#### 개선 사항

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

PR 이전의 이슈 작성은 선택 사항입니다. 생략하는 경우 PR 에 세부 사항을 포함하십시오. PR 은 집중도를 유지하고, 이슈 번호를 명시하며, 테스트를 추가하거나 부재 사유를 설명하고, 동작 변경/위험을 문서화하며, 증거로 마스킹된 로그/스크린샷을 포함하고, 제출 전에 적절한 검증을 실행하십시오.
