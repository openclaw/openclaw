---
read_when:
    - 공급자 사용량/할당량 표면을 연결하고 있습니다.
    - 사용 추적 동작 또는 인증 요구 사항을 설명해야 합니다.
summary: 사용 추적 표면 및 자격 증명 요구 사항
title: 사용량 추적
x-i18n:
    generated_at: "2026-02-08T15:54:40Z"
    model: gtx
    provider: google-translate
    source_hash: 6f6ed2a70329b2a6206c327aa749a84fbfe979762caca5f0e7fb556f91631cbb
    source_path: concepts/usage-tracking.md
    workflow: 15
---

# 사용량 추적

## 그것은 무엇입니까

- 공급자 사용량/할당량을 사용량 끝점에서 직접 가져옵니다.
- 예상 비용이 없습니다. 공급자가 보고한 창만.

## 나타나는 곳

- `/status` 채팅: 세션 토큰 + 예상 비용(API 키만)이 포함된 이모티콘이 풍부한 상태 카드. 다음에 대한 공급자 사용량이 표시됩니다. **현재 모델 제공자** 가능한 경우.
- `/usage off|tokens|full` 채팅: 응답별 사용량 바닥글(OAuth는 토큰만 표시)
- `/usage cost` 채팅: OpenClaw 세션 로그에서 집계된 현지 비용 요약.
- CLI: `openclaw status --usage` 공급자별 전체 분석을 인쇄합니다.
- CLI: `openclaw channels list` 공급자 구성과 함께 동일한 사용량 스냅샷을 인쇄합니다(사용 `--no-usage` 건너 뛰기).
- macOS 메뉴 표시줄: 컨텍스트 아래의 "사용" 섹션(사용 가능한 경우에만)

## 공급자 + 자격 증명

- **인류학(클로드)**: 인증 프로필의 OAuth 토큰입니다.
- **GitHub 코파일럿**: 인증 프로필의 OAuth 토큰입니다.
- **제미니 CLI**: 인증 프로필의 OAuth 토큰입니다.
- **반중력**: 인증 프로필의 OAuth 토큰입니다.
- **오픈AI 코덱스**: 인증 프로필의 OAuth 토큰(있는 경우 accountId가 사용됨)
- **미니맥스**: API 키(코딩 계획 키; `MINIMAX_CODE_PLAN_KEY` 또는 `MINIMAX_API_KEY`); 5시간 코딩 계획 기간을 사용합니다.
- **z.ai**: env/config/auth 저장소를 통한 API 키입니다.

일치하는 OAuth/API 자격 증명이 없으면 사용법이 숨겨집니다.
