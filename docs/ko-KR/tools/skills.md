---
summary: "스킬 생성 및 관리 상세 가이드"
read_when:
  - 커스텀 스킬을 만들고 싶을 때
title: "스킬"
---

# 스킬

스킬은 에이전트에게 특정 기능이나 지식을 추가하는 모듈입니다.

## 스킬이란?

스킬은 다음을 포함할 수 있습니다:

- 에이전트에게 주입되는 프롬프트
- 커스텀 도구 정의
- 참조 문서 및 예시

## 스킬 구조

```
~/.openclaw/workspace/skills/
└── my-skill/
    ├── SKILL.md          # 필수: 스킬 정의
    ├── examples/         # 선택: 예시
    └── resources/        # 선택: 추가 리소스
```

## SKILL.md 형식

```markdown
---
name: my-skill
description: 스킬에 대한 간단한 설명
version: 1.0.0
author: your-name
---

# 스킬 이름

## 개요

이 스킬이 무엇을 하는지 설명합니다.

## 사용 방법

에이전트가 이 스킬을 사용하는 방법을 설명합니다.

## 예시

구체적인 사용 예시를 제공합니다.
```

## 스킬 활성화/비활성화

### 채팅에서

```
/skill enable my-skill
/skill disable my-skill
/skill list
```

### 설정에서

```json5
{
  agents: {
    defaults: {
      skills: {
        enabled: ["my-skill", "another-skill"],
        disabled: ["unwanted-skill"],
      },
    },
  },
}
```

## 스킬 예시

### 웹 검색 스킬

```markdown
---
name: web-search
description: 웹 검색 기능
---

# 웹 검색 스킬

## 사용 시점

사용자가 최신 정보나 현재 이벤트에 대해 질문할 때
이 스킬을 사용하여 웹에서 정보를 검색합니다.

## 검색 방법

1. 검색어 결정
2. browser 도구로 검색
3. 결과 요약 및 출처 제공
```

### 코드 리뷰 스킬

```markdown
---
name: code-review
description: 코드 리뷰 가이드라인
---

# 코드 리뷰 스킬

## 리뷰 체크리스트

- [ ] 명명 규칙
- [ ] 에러 처리
- [ ] 테스트 커버리지
- [ ] 성능 고려사항
- [ ] 보안 취약점

## 피드백 형식

1. 문제 설명
2. 영향 분석
3. 개선 제안
4. 코드 예시
```

### 번역 스킬

```markdown
---
name: translator
description: 다국어 번역
---

# 번역 스킬

## 지원 언어

한국어, 영어, 일본어, 중국어

## 번역 가이드라인

- 의미 전달 우선
- 문화적 맥락 고려
- 기술 용어 일관성 유지
```

## 채널별 스킬 제한

특정 그룹이나 채널에서 사용 가능한 스킬 제한:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-123456789": {
          skills: ["code-review"], // 이 그룹에서는 code-review만
        },
      },
    },
  },
}
```

## 스킬과 도구

스킬 내에서 커스텀 도구 정의:

```markdown
---
name: calculator
description: 계산 도구
tools:
  - name: calculate
    description: 수학 계산 수행
    parameters:
      expression:
        type: string
        description: 계산할 수식
---

# 계산기 스킬

이 스킬은 `calculate` 도구를 사용하여 수학 계산을 수행합니다.
```

## 스킬 공유

### 설치

```bash
# Git에서 스킬 설치
git clone https://github.com/user/openclaw-skill-name ~/.openclaw/workspace/skills/skill-name
```

### 배포

1. GitHub 저장소 생성
2. SKILL.md 및 관련 파일 추가
3. 다른 사용자와 공유

## 스킬 디버깅

### 스킬 확인

```bash
# 로드된 스킬 목록
openclaw skills list

# 스킬 상세 정보
openclaw skills info my-skill
```

### 스킬 테스트

```
/skill enable my-skill
# 스킬 기능 테스트
/skill disable my-skill
```

## 베스트 프랙티스

1. **명확한 설명**: 스킬 목적을 분명히 설명
2. **구체적인 예시**: 사용 방법을 예시로 보여줌
3. **모듈화**: 하나의 스킬은 하나의 기능에 집중
4. **버전 관리**: 스킬 변경 이력 관리
