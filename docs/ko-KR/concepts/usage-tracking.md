---
summary: "Usage tracking surfaces and credential requirements"
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: "Usage Tracking"
x-i18n:
  source_hash: 6f6ed2a70329b2a6206c327aa749a84fbfe979762caca5f0e7fb556f91631cbb
---

# 사용 추적

## 그게 뭐야?

- 공급자 사용량/할당량을 사용량 끝점에서 직접 가져옵니다.
- 예상 비용이 없습니다. 공급자가 보고한 창만.

## 나타나는 곳

- 채팅의 `/status`: 세션 토큰 + 예상 비용(API 키만)이 포함된 이모티콘이 풍부한 상태 카드. 가능한 경우 **현재 모델 제공자**에 대한 제공자 사용량이 표시됩니다.
- 채팅의 `/usage off|tokens|full`: 응답별 사용 바닥글(OAuth는 토큰만 표시)
- 채팅의 `/usage cost`: OpenClaw 세션 로그에서 집계된 로컬 비용 요약.
- CLI: `openclaw status --usage`는 공급자별 전체 분석을 인쇄합니다.
- CLI: `openclaw channels list`는 공급자 구성과 함께 동일한 사용량 스냅샷을 인쇄합니다(건너뛰려면 `--no-usage` 사용).
- macOS 메뉴 표시줄: 컨텍스트 아래의 "사용" 섹션(사용 가능한 경우에만)

## 공급자 + 자격 증명

- **Anthropic(Claude)**: 인증 프로필의 OAuth 토큰입니다.
- **GitHub Copilot**: 인증 프로필의 OAuth 토큰.
- **Gemini CLI**: 인증 프로필의 OAuth 토큰.
- **반중력**: 인증 프로필의 OAuth 토큰.
- **OpenAI Codex**: 인증 프로필의 OAuth 토큰(있는 경우 accountId가 사용됨).
- **MiniMax**: API 키(코딩 계획 키; `MINIMAX_CODE_PLAN_KEY` 또는 `MINIMAX_API_KEY`); 5시간 코딩 계획 창을 사용합니다.
- **z.ai**: env/config/auth 저장소를 통한 API 키입니다.

일치하는 OAuth/API 자격 증명이 없으면 사용법이 숨겨집니다.
