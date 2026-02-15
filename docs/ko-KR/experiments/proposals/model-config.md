---
summary: "Exploration: model config, auth profiles, and fallback behavior"
read_when:
  - Exploring future model selection + auth profile ideas
title: "Model Config Exploration"
x-i18n:
  source_hash: 48623233d80f874c0ae853b51f888599cf8b50ae6fbfe47f6d7b0216bae9500b
---

# 모델 구성(탐색)

이 문서에는 향후 모델 구성에 대한 **아이디어**가 담겨 있습니다. 그것은 아니다
배송사양 현재 동작은 다음을 참조하세요.

- [모델](/concepts/models)
- [모델 장애 조치](/concepts/model-failover)
- [OAuth + 프로필](/concepts/oauth)

## 동기부여

운영자가 원하는 것:

- 공급자당 여러 인증 프로필(개인 및 업무).
- 예측 가능한 대체 기능을 갖춘 간단한 `/model` 선택.
- 텍스트 모델과 이미지 지원 모델을 명확하게 구분합니다.

## 가능한 방향(상위 수준)

- 선택적 별칭을 사용하여 모델 선택을 간단하게 유지하세요: `provider/model`.
- 공급자가 명시적인 순서에 따라 여러 인증 프로필을 갖도록 합니다.
- 모든 세션이 일관되게 장애 조치되도록 전역 대체 목록을 사용합니다.
- 명시적으로 구성된 경우에만 이미지 라우팅을 재정의합니다.

## 공개 질문

- 프로필 교체는 공급자별로 이루어져야 할까요, 아니면 모델별로 이루어져야 할까요?
- 세션에 대한 UI 표면 프로필 선택은 어떻게 해야 합니까?
- 레거시 구성 키에서 가장 안전한 마이그레이션 경로는 무엇입니까?
