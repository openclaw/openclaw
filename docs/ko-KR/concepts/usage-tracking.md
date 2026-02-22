---
summary: "사용 추적 표면 및 자격 증명 요구 사항"
read_when:
  - 프로바이더 사용/쿼터 표면을 연결하고 있습니다.
  - 사용 추적 동작이나 인증 요구 사항을 설명해야 합니다.
title: "사용 추적"
---

# 사용 추적

## 설명

- 프로바이더 사용/쿼터를 그들의 사용 엔드포인트에서 직접 가져옵니다.
- 추정 비용은 없으며, 프로바이더가 보고한 윈도우만 포함됩니다.

## 표시 위치

- 채팅 내 `/status`: 이모지‑풍부한 상태 카드로 세션 토큰 + 추정 비용을 표시합니다 (API 키만 해당). 프로바이더 사용은 **현재 모델 프로바이더**에 대해 사용 가능할 때 표시됩니다.
- 채팅 내 `/usage off|tokens|full`: 응답 당 사용 풋터 (OAuth는 토큰만 표시).
- 채팅 내 `/usage cost`: OpenClaw 세션 로그에서 집계된 로컬 비용 요약.
- CLI: `openclaw status --usage`는 프로바이더별 전체 분석을 출력합니다.
- CLI: `openclaw channels list`는 프로바이더 설정과 함께 동일한 사용 스냅샷을 출력합니다 (`--no-usage`를 사용하여 건너뛸 수 있음).
- macOS 메뉴 막대: "사용" 섹션은 컨텍스트 아래에 표시됩니다 (사용 가능한 경우에만).

## 프로바이더 + 자격 증명

- **Anthropic (Claude)**: 인증 프로파일 내 OAuth 토큰.
- **GitHub Copilot**: 인증 프로파일 내 OAuth 토큰.
- **Gemini CLI**: 인증 프로파일 내 OAuth 토큰.
- **Antigravity**: 인증 프로파일 내 OAuth 토큰.
- **OpenAI Codex**: 인증 프로파일 내 OAuth 토큰 (accountId가 있을 때 사용).
- **MiniMax**: API 키 (코딩 계획 키; `MINIMAX_CODE_PLAN_KEY` 또는 `MINIMAX_API_KEY`); 5시간 코딩 계획 윈도우를 사용.
- **z.ai**: 환경/설정/인증 스토어를 통한 API 키.

매칭되는 OAuth/API 자격 증명이 없으면 사용 정보는 숨겨집니다.
