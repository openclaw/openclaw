---
summary: 높은 신호 PR을 제출하는 방법
title: PR 제출
x-i18n:
    generated_at: "2026-02-08T15:55:48Z"
    model: gtx
    provider: google-translate
    source_hash: 277b0f51b948d1a9285cc9b5a89f909a5827dbb5fc7e09c7eca78d3b5bb9ad95
    source_path: help/submitting-a-pr.md
    workflow: 15
---

좋은 PR은 검토하기 쉽습니다. 검토자는 의도를 빠르게 파악하고 행동을 확인하며 토지 변경을 안전하게 수행해야 합니다. 이 가이드는 인간 및 LLM 검토를 위한 간결하고 중요한 제출물을 다룹니다.

## 좋은 PR을 만드는 것

- [ ] 문제, 그것이 중요한 이유 및 변경 사항을 설명하십시오.
- [ ] 변화에 집중하세요. 광범위한 리팩터링을 피하세요.
- [ ] 사용자에게 표시되는/구성/기본 변경 사항을 요약합니다.
- [ ] 테스트 적용 범위, 건너뛰기 및 이유를 나열합니다.
- [ ] 증거 추가: 로그, 스크린샷, 녹음(UI/UX).
- [ ] 코드 워드: 이 가이드를 읽는 경우 PR 설명에 "lobster-biscuit"를 입력하세요.
- [ ] 관련 실행/수정 `pnpm` PR을 생성하기 전에 명령을 실행합니다.
- [ ] 관련 기능/문제/수정 사항을 보려면 코드베이스 및 GitHub를 검색하세요.
- [ ] 증거나 관찰에 기초한 주장.
- [ ] 좋은 제목: 동사 + 범위 + 결과(예: `Docs: add PR and issue templates`).

간결하게 작성하세요. 간결한 복습 > 문법. 해당되지 않는 부분은 생략하세요.

### 기준 유효성 검사 명령(변경 사항에 대한 실행/실패 수정)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- 프로토콜 변경: `pnpm protocol:check`

## 점진적 공개

- 상단: 요약/의도
- 다음: 변경/위험
- 다음: 테스트/검증
- 마지막: 구현/증거

## 일반적인 PR 유형: 세부 사항

- [ ] 수정: 재현, 근본 원인, 확인을 추가합니다.
- [ ] 기능: 사용 사례, 동작/데모/스크린샷(UI)을 추가합니다.
- [ ] 리팩토링: "동작 변경 없음"을 명시하고 이동/단순화한 내용을 나열합니다.
- [ ] 집안일: 이유를 설명합니다(예: 빌드 시간, CI, 종속성).
- [ ] 문서: 전후 컨텍스트, 업데이트된 페이지 링크, 실행 `pnpm format`.
- [ ] 테스트: 어떤 공백이 메워졌는가? 회귀를 방지하는 방법.
- [ ] 성능: 이전/이후 측정항목 및 측정 방법을 추가합니다.
- [ ] UX/UI: 스크린샷/비디오, 접근성 영향을 참고하세요.
- [ ] 인프라/빌드: 환경/검증.
- [ ] 보안: 위험, 재현, 검증, 민감한 데이터 없음을 요약합니다. 근거 있는 주장만 가능합니다.

## 체크리스트

- [ ] 명확한 문제/의도
- [ ] 집중된 범위
- [ ] 목록 동작 변경 사항
- [ ] 테스트 목록 및 결과
- [ ] 수동 테스트 단계(해당하는 경우)
- [ ] 비밀/개인 데이터 없음
- [ ] 증거 기반

## 일반홍보템플릿

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

## PR 유형 템플릿(해당 유형으로 교체)

### 고치다

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

### 특징

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

### 집안일/유지관리

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

### 시험

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

### 성능

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

### 인프라/구축

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
