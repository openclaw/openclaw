---
type: session-log
tags: [model-migration, openai-codex, oauth, risk-mitigation, maibot]
project: MAIBOT
related:
  - "[[preferences|사용자 선호설정]]"
  - "[[maibot-commands|MAIBOT 명령어]]"
---

# 2026-02-22 모델 전환 기록 (OpenAI Codex)

## 목적

- MAIBOT 기본 모델을 Anthropic 계열에서 OpenAI Codex OAuth 기반으로 전환
- Anthropic(Claude 구독 OAuth) 서드파티 차단 정책 리스크 제거

## 배경

- Anthropic이 2026-01-09부터 Claude Pro/Max OAuth 토큰의 서드파티 도구 사용을 서버 레벨에서 차단
- 따라서 OpenClaw/MAIBOT에서 Anthropic OAuth 경로를 남겨두면 인증 실패/정책 충돌 위험이 지속됨

## 실행 내용

### 1) 기본 모델 전환

- default: `openai-codex/gpt-5.3-codex`
- fallback: `openai-codex/gpt-5.3-codex-spark`

### 2) Anthropic 잔존 설정 정리

아래 항목을 모두 제거/치환:

- `~/.openclaw/openclaw.json`
  - `auth.profiles.anthropic:claude_code_oauth_token` 제거
  - `models.providers.anthropic` 제거
  - `agents.defaults.models["anthropic/claude-opus-4-6"]` 제거
- `~/.openclaw/agents/main/agent/auth-profiles.json`
  - `profiles.anthropic:claude_code_oauth_token` 제거
  - `lastGood.anthropic` 제거
  - `usageStats.anthropic:claude_code_oauth_token` 제거

### 3) alias 안전치환

- `claude-max` alias를 Anthropic 대상에서
- `openai-codex/gpt-5.3-codex`로 재매핑

## 검증 결과

- `openclaw models status`
  - Default: `openai-codex/gpt-5.3-codex`
  - Providers w/ OAuth/tokens: `openai-codex (1)` only
- `openclaw models list`
  - `openai-codex/gpt-5.3-codex` (default)
  - `openai-codex/gpt-5.3-codex-spark` (fallback)
- `anthropic` 관련 모델/토큰/alias 의존 경로 제거 완료

## 결론

- MAIBOT 운영 경로에서 Anthropic OAuth 정책 차단 리스크는 실질적으로 제거됨
- 현재 모델 운영은 OpenAI Codex OAuth 단일 경로로 안정화됨
