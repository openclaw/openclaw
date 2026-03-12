---
name: model-router
description: "Auto-route MAIBOT session model (Sonnet 4.6 ↔ Opus 4.6) by complexity. Applied automatically on every inbound message. Evaluates task complexity and selects optimal model. NOT for: explicit /model commands."
metadata:
  openclaw:
    emoji: "🧭"
---

# Model Router — Sonnet ↔ Opus Auto-Routing

Evaluate each request's complexity and switch via `session_status(model=...)`.

## Routing Matrix

| Complexity   | Model      | `model=` | Criteria                                                       |
| ------------ | ---------- | -------- | -------------------------------------------------------------- |
| **Low**      | Sonnet 4.6 | `sonnet` | 일상 대화, 상태 확인, 간단한 질문, 파일 읽기, 단순 편집        |
| **Medium**   | Sonnet 4.6 | `sonnet` | 코드 구현, 버그 수정, 문서 작성, API 호출, 크론 실행           |
| **High**     | Opus 4.6   | `opus`   | 아키텍처 설계, 복잡한 디버깅, 멀티스텝 자동화, 크로스 프로젝트 |
| **Critical** | Opus 4.6   | `opus`   | 보안, 프로덕션 배포, 재무/매매 결정, 장기 전략                 |

## Quick Decision Guide

**→ Sonnet**: 단순 요청("~해줘", "~확인해"), 파일 1-2개 수정, 단일 프로젝트, 정보 조회, git ops, 하트비트
**→ Opus**: 추론 요청("설계해줘", "분석해줘", "왜?"), 멀티 파일/프로젝트, 근본 원인 분석, 아키텍처, 브라우저 자동화, 사업 전략

## Transition Rules

1. **세션 시작** → Sonnet (빠른 응답 우선)
2. **복잡도 상승** → Opus 전환
3. **작업 완료** → Sonnet 복귀
4. **`/model` 명시 지정** → 라우터 미개입
5. **하트비트** → 항상 Sonnet
6. **이미 올바른 모델** → 전환 금지 (API 낭비 방지)
7. **작업 중간** → 전환 금지 (다음 턴에서 전환)

## Execution

```
session_status(model="sonnet")   # 기본 — 대부분의 요청
session_status(model="opus")     # 복잡한 작업 감지 시
session_status(model="default")  # 오버라이드 해제
```

전환 시 로그 없이 투명하게 동작. 지니님 문의 시에만 현재 모델 안내.

For detailed criteria and examples, see [references/routing-logic.md](references/routing-logic.md).
