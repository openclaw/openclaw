---
read_when:
    - 저장소에서 스크립트 실행
    - ./scripts 아래에 스크립트 추가 또는 변경
summary: '저장소 스크립트: 목적, 범위 및 안전 참고 사항'
title: 스크립트
x-i18n:
    generated_at: "2026-02-08T16:01:19Z"
    model: gtx
    provider: google-translate
    source_hash: efd220df28f20b338fbc4f5e6152c8abeade4b56f76496476e7e99928a8dedbe
    source_path: help/scripts.md
    workflow: 15
---

# 스크립트

그만큼 `scripts/` 디렉터리에는 로컬 워크플로 및 운영 작업을 위한 도우미 스크립트가 포함되어 있습니다.
작업이 스크립트에 명확하게 연결되어 있는 경우 이를 사용하세요. 그렇지 않으면 CLI를 선호합니다.

## 규칙

- 스크립트는 **선택 과목** 문서나 릴리스 체크리스트에서 참조되지 않는 한.
- 존재하는 경우 CLI 표면을 선호합니다(예: 인증 모니터링에서는 `openclaw models status --check`).
- 스크립트는 호스트별로 다르다고 가정합니다. 새 컴퓨터에서 실행하기 전에 읽어보십시오.

## 인증 모니터링 스크립트

인증 모니터링 스크립트는 여기에 설명되어 있습니다.
[/자동화/인증 모니터링](/automation/auth-monitoring)

## 스크립트를 추가할 때

- 스크립트에 집중하고 문서화하세요.
- 관련 문서에 짧은 항목을 추가합니다(또는 누락된 경우 항목을 만듭니다).
