---
summary: "높은 신호의 PR 을 제출하는 방법"
title: "PR 제출하기"
---

좋은 PR 은 검토하기 쉽습니다. 리뷰어는 의도를 빠르게 파악하고, 동작을 검증하며, 변경 사항을 안전하게 병합할 수 있어야 합니다. 이 가이드는 사람과 LLM 검토를 모두 고려한 간결하고 신호 밀도가 높은 제출 방법을 다룹니다.

## 좋은 PR 의 기준

- [ ] 문제, 왜 중요한지, 그리고 변경 내용을 설명합니다.
- [ ] 변경 범위를 집중적으로 유지합니다. 광범위한 리팩터링은 피하십시오.
- [ ] 사용자에게 보이는 변경 사항 / 구성 / 기본값 변경을 요약합니다.
- [ ] 테스트 커버리지, 스킵 항목, 그리고 그 이유를 나열합니다.
- [ ] 증거를 추가합니다: 로그, 스크린샷, 또는 녹화본 (UI/UX).
- [ ] 코드 워드: 이 가이드를 읽었다면 PR 설명에 ‘lobster-biscuit’를 넣으십시오.
- [ ] PR 생성 전에 관련 `pnpm` 명령을 실행하고 실패를 수정합니다.
- [ ] 관련 기능 / 이슈 / 수정 사항을 코드베이스와 GitHub 에서 검색합니다.
- [ ] 주장은 증거 또는 관찰에 근거해야 합니다.
- [ ] 좋은 제목: 동사 + 범위 + 결과 (예: `Docs: add PR and issue templates`).

간결함을 유지하십시오. 간결한 리뷰 > 문법. Omit any non-applicable sections.

### 기준 검증 명령 (변경 사항에 대해 실행하고 실패를 수정)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 프로토콜 변경: `pnpm protocol:check`

## 점진적 정보 공개

- 상단: 요약 / 의도
- 다음: 변경 사항 / 위험
- 다음: 테스트 / 검증
- 마지막: 구현 / 증거

## 일반적인 PR 유형: 세부 사항

- [ ] 수정: 재현 방법, 근본 원인, 검증을 추가합니다.
- [ ] 기능: 사용 사례, 동작 / 데모 / 스크린샷 (UI) 를 추가합니다.
- [ ] 리팩터링: ‘동작 변경 없음’을 명시하고, 이동 / 단순화된 내용을 나열합니다.
- [ ] 잡무: 이유를 명시합니다 (예: 빌드 시간, CI, 의존성).
- [ ] 문서: 변경 전 / 후 맥락, 업데이트된 페이지 링크, `pnpm format` 실행.
- [ ] 테스트: 어떤 공백을 다루는지, 회귀를 어떻게 방지하는지.
- [ ] 성능: 변경 전 / 후 지표와 측정 방법을 추가합니다.
- [ ] UX/UI: 스크린샷 / 비디오, 접근성 영향 명시.
- [ ] 인프라 / 빌드: 환경 / 검증.
- [ ] 보안: 위험 요약, 재현, 검증, 민감 데이터 없음. 근거 있는 주장만 허용합니다.

## 체크리스트

- [ ] 명확한 문제 / 의도
- [ ] 집중된 범위
- [ ] 동작 변경 목록
- [ ] 테스트 목록 및 결과
- [ ] 수동 테스트 단계 (해당되는 경우)
- [ ] 비밀 / 개인 데이터 없음
- [ ] 증거 기반

## 일반 PR 템플릿

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## PR 유형별 템플릿 (해당 유형으로 교체)

### 수정

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 기능

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 리팩터링

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 문서

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 테스트

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 인프라 / 빌드

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### 보안

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
