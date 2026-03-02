---
summary: "OpenClaw의 OAuth: token exchange, storage, multi-account patterns"
read_when:
  - OpenClaw OAuth를 end-to-end로 이해하려고 할 때
  - token invalidation / logout issues를 hit했을 때
  - setup-token 또는 OAuth auth flows를 원할 때
  - 여러 계정 또는 profile 라우팅을 원할 때
title: "OAuth"
---

# OAuth

OpenClaw는 이를 제공하는 providers (notably **OpenAI Codex (ChatGPT OAuth)**)에 대해 "subscription auth"를 통한 OAuth를 지원합니다. Anthropic subscriptions의 경우 **setup-token** 흐름을 사용합니다. 이 페이지는 다음을 설명합니다:

- OAuth **token exchange**가 작동하는 방법 (PKCE)
- tokens이 **저장되는 위치** (그리고 왜)
- **여러 계정**을 처리하는 방법 (profiles + per-session overrides)

OpenClaw는 또한 자체 OAuth 또는 API‑key
flows를 제공하는 **provider plugins**를 지원합니다. 다음을 통해 실행합니다:

```bash
openclaw models auth login --provider <id>
```

## Token sink (왜 존재하는가)

OAuth providers는 일반적으로 로그인/새로고침 flows 중 **새 refresh token**을 발행합니다. 일부 providers (또는 OAuth clients)는 같은 user/app에 대해 새로운 새로고침 token이 발행될 때 오래된 refresh tokens를 무효화할 수 있습니다.

실제 증상:

- OpenClaw _및_ Claude Code / Codex CLI를 통해 로그인 → 둘 중 하나가 나중에 임의로 "logged out"됨

이를 줄이기 위해 OpenClaw는 `auth-profiles.json`을 **token sink**로 취급합니다:

- 런타임은 **한 곳에서** 자격증명을 읽습니다
- 우리는 여러 profiles를 유지하고 이들을 결정론적으로 라우팅할 수 있습니다

## Storage (tokens가 사는 곳)

비밀은 **per-agent** 저장됩니다:

- Auth profiles (OAuth + API 키 + optional value-level refs): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- Legacy compatibility file: `~/.openclaw/agents/<agentId>/agent/auth.json`
  (static `api_key` entries은 발견될 때 scrubbed됨)

Legacy import-only file (여전히 지원됨, 하지만 메인 스토어가 아님):

- `~/.openclaw/credentials/oauth.json` (첫 사용에서 `auth-profiles.json`로 imported됨)

위의 모든 것은 또한 `$OPENCLAW_STATE_DIR` (state dir override)를 존중합니다. 전체 참고: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

Static secret refs 및 runtime snapshot activation 동작은 [비밀 관리](/gateway/secrets)를 참조합니다.

## Anthropic setup-token (subscription auth)

`claude setup-token`을 어떤 머신에서든 실행한 다음 OpenClaw에 paste합니다:

```bash
openclaw models auth setup-token --provider anthropic
```

토큰을 다른 곳에서 생성한 경우 수동으로 paste합니다:

```bash
openclaw models auth paste-token --provider anthropic
```

확인합니다:

```bash
openclaw models status
```

## OAuth exchange (로그인이 작동하는 방법)

OpenClaw의 interactive login flows는 `@mariozechner/pi-ai`에서 구현되고 wizards/commands에 wired됩니다.

### Anthropic (Claude Pro/Max) setup-token

Flow shape:

1. `claude setup-token` 실행
2. OpenClaw에 token을 paste
3. token auth profile (no refresh)로 저장

Wizard 경로는 `openclaw onboard` → auth choice `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

Flow shape (PKCE):

1. PKCE verifier/challenge + random `state` 생성
2. `https://auth.openai.com/oauth/authorize?...` 열기
3. callback을 `http://127.0.0.1:1455/auth/callback`에서 캡처하려고 시도
4. callback이 bind할 수 없는 경우 (또는 you're remote/headless), redirect URL/code을 paste
5. `https://auth.openai.com/oauth/token`에서 교환
6. access token에서 `accountId` 추출 및 `{ access, refresh, expires, accountId }` 저장

Wizard 경로는 `openclaw onboard` → auth choice `openai-codex`.

## Refresh + expiry

Profiles은 `expires` 타임스탬프를 저장합니다.

런타임에서:

- `expires`가 미래에 있으면 → 저장된 access token을 사용
- 만료된 경우 → refresh (file lock 아래에서) 및 저장된 자격증명 덮어씀

Refresh 흐름은 자동입니다; 일반적으로 tokens를 수동으로 관리할 필요가 없습니다.

## 여러 계정 (profiles) + 라우팅

두 가지 패턴:

### 1) 선호: 별도 agents

"personal"과 "work"가 절대 상호작용하지 않길 원하는 경우, isolated agents (별도 세션 + 자격증명 + 워크스페이스)를 사용합니다:

```bash
openclaw agents add work
openclaw agents add personal
```

그 다음 agent별로 auth를 설정 (wizard) 및 chats를 올바른 agent로 라우팅합니다.

### 2) 고급: 한 agent에 여러 profiles

`auth-profiles.json`은 같은 provider에 대해 여러 profile ID를 지원합니다.

어떤 profile이 사용되는지 선택하십시오:

- globally via config ordering (`auth.order`)
- per-session via `/model ...@<profileId>`

예시 (session override):

- `/model Opus@anthropic:work`

어떤 profile ID가 존재하는지 보기:

- `openclaw channels list --json` (shows `auth[]`)

관련 문서:

- [/concepts/model-failover](/concepts/model-failover) (rotation + cooldown 규칙)
- [/tools/slash-commands](/tools/slash-commands) (command surface)
