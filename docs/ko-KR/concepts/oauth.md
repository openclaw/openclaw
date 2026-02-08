---
summary: "OAuth 토큰 교환, 저장, 다중 계정 패턴"
read_when:
  - OAuth 기반 모델 인증을 설정할 때
  - Claude Pro/Max 구독이나 Codex로 접속할 때
title: "OAuth 인증"
---

# OAuth 인증

OpenClaw는 Anthropic, OpenAI Codex, GitHub Copilot 등의 구독 서비스에 OAuth로 접속할 수 있습니다. API 키 없이 기존 구독을 활용하는 방법입니다.

## 토큰 저장소

모든 인증 프로필은 에이전트별로 저장됩니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

이 파일이 **단일 읽기 지점(token sink)** 역할을 합니다. 여러 클라이언트가 토큰을 갱신해도 충돌을 방지합니다.

## Anthropic (Claude Pro/Max)

Claude 구독으로 API 키 없이 모델에 접근합니다.

### setup-token 흐름

```bash
# 1. Claude 데스크톱에서 setup-token 생성
claude setup-token

# 2. OpenClaw에 등록
openclaw models auth setup-token

# 3. 표시되는 토큰을 붙여넣기
```

등록 후 자동으로 OAuth 토큰 교환이 이루어집니다. 토큰 갱신도 자동입니다.

## OpenAI Codex

PKCE 흐름으로 OpenAI 모델에 접근합니다:

```bash
openclaw models auth openai-codex
```

1. 브라우저에서 OpenAI 로그인 페이지 열림
2. 로그인 후 `http://127.0.0.1:1455/auth/callback`으로 콜백
3. 토큰 자동 저장

## GitHub Copilot

```bash
openclaw models auth github-copilot
```

브라우저에서 GitHub 로그인 후 OAuth 토큰이 자동 저장됩니다.

## 다중 계정 패턴

### 에이전트별 격리 (권장)

```json5
{
  agents: {
    list: [
      { id: "personal" },   // personal의 auth-profiles.json 사용
      { id: "work" },       // work의 auth-profiles.json 사용
    ],
  },
}
```

### 세션별 오버라이드

같은 에이전트 내에서 세션별로 다른 프로필 사용:

```
/model anthropic/claude-opus-4-6@work-profile
```

## 토큰 갱신

OAuth 토큰은 자동으로 갱신됩니다:

1. 만료 전 자동 갱신 시도
2. 갱신 실패 시 해당 프로필 쿨다운
3. 다음 가능한 프로필로 회전 ([모델 장애 조치](/ko-KR/concepts/model-failover))
4. 갱신 가능해지면 자동 복구

## 사용량 추적

```
/usage full     # 전체 사용량
/usage cost     # 비용 정보
/status         # 상태 요약
```

지원: Anthropic, GitHub Copilot, Gemini CLI, OpenAI Codex

## 보안

- 토큰은 로컬 파일 시스템에만 저장
- `auth-profiles.json` 파일 권한 관리 권장
- 토큰 정보는 로그에 자동 마스킹

## 다음 단계

- [모델 프로바이더](/ko-KR/concepts/model-providers) - 전체 프로바이더 목록
- [모델 장애 조치](/ko-KR/concepts/model-failover) - 프로필 회전과 폴백
- [보안](/ko-KR/gateway/security) - 게이트웨이 보안 설정
