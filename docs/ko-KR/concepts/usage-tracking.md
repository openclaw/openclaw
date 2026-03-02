---
summary: "사용 추적 surfaces 및 자격증명 요구사항"
read_when:
  - Provider usage/quota surfaces를 연결하고 있을 때
  - 사용 추적 동작 또는 auth 요구사항을 설명해야 할 때
title: "사용 추적"
---

# 사용 추적

## 그것이 무엇인가

- Provider usage/quota를 직접 usage endpoints에서 가져옵니다.
- 추정 비용 없음; provider-reported windows만.

## 표시되는 곳

- Chat에서 `/status`: emoji‑rich status card이며 session tokens + estimated cost (API key만). Provider usage는 **current model provider**에 대해 사용 가능할 때 표시됩니다.
- Chat에서 `/usage off|tokens|full`: per-response usage footer (OAuth는 tokens만 표시).
- Chat에서 `/usage cost`: OpenClaw session logs에서 aggregated된 local cost 요약.
- CLI: `openclaw status --usage`는 full per-provider 분석을 인쇄합니다.
- CLI: `openclaw channels list`는 provider 설정과 함께 같은 usage snapshot을 인쇄합니다 (skip하려면 `--no-usage` 사용).
- macOS menu bar: Context 아래 "Usage" 섹션 (available한 경우만).

## Providers + 자격증명

- **Anthropic (Claude)**: auth profiles의 OAuth tokens.
- **GitHub Copilot**: auth profiles의 OAuth tokens.
- **Gemini CLI**: auth profiles의 OAuth tokens.
- **Antigravity**: auth profiles의 OAuth tokens.
- **OpenAI Codex**: auth profiles의 OAuth tokens (accountId가 존재할 때 사용됨).
- **MiniMax**: API key (coding plan key; `MINIMAX_CODE_PLAN_KEY` 또는 `MINIMAX_API_KEY`); 5‑hour coding plan window를 사용합니다.
- **z.ai**: env/config/auth store를 통한 API key.

usage는 matching OAuth/API credentials가 존재하지 않으면 숨겨집니다.
