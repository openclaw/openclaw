---
summary: "OpenClaw의 OAuth: 토큰 교환, 저장, 다중 계정 패턴"
read_when:
  - OpenClaw OAuth 전체 흐름을 이해하고 싶을 때
  - 토큰 무효화 / 로그아웃 문제에 직면했을 때
  - setup-token 또는 OAuth 인증 흐름을 원할 때
  - 여러 계정 또는 프로필 라우팅을 원할 때
title: "OAuth"
---

# OAuth

OpenClaw는 OAuth를 통한 "구독 인증"을 지원하며, 이를 제공하는 프로바이더 (주로 **OpenAI Codex (ChatGPT OAuth)**)에서 사용할 수 있습니다. Anthropic 구독에는 **setup-token** 흐름을 사용하세요. 이 페이지에서는 다음을 설명합니다:

- OAuth **토큰 교환**이 어떻게 작동하는지 (PKCE)
- 토큰이 **어디에 저장**되는지 (그리고 그 이유)
- **여러 개의 계정**을 어떻게 처리하는지 (프로필 + 세션별 오버라이드)

OpenClaw는 자체 OAuth 또는 API 키 흐름을 지원하는 **프로바이더 플러그인**도 지원합니다. 다음 명령어로 실행하세요:

```bash
openclaw models auth login --provider <id>
```

## 토큰 싱크 (존재 이유)

OAuth 프로바이더는 일반적으로 로그인/리프레시 흐름 중에 **새 리프레시 토큰**을 생성합니다. 일부 프로바이더 (또는 OAuth 클라이언트)는 동일 사용자/앱에 대해 새 토큰이 발급되면 이전의 리프레시 토큰을 무효화할 수 있습니다.

실질적인 증상:

- OpenClaw와 Claude Code / Codex CLI를 통해 로그인하면 → 그 중 하나가 나중에 랜덤하게 "로그아웃"됩니다.

이를 줄이기 위해, OpenClaw는 `auth-profiles.json`을 **토큰 싱크**로 취급합니다:

- 런타임은 **한 곳**에서 자격 증명을 읽습니다
- 우리는 여러 프로필을 유지하고 확정적으로 라우팅할 수 있습니다

## 저장소 (토큰이 저장되는 위치)

비밀은 **에이전트 별로** 저장됩니다:

- 인증 프로필 (OAuth + API 키): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 런타임 캐시 (자동 관리; 수정하지 마세요): `~/.openclaw/agents/<agentId>/agent/auth.json`

레거시 가져오기 전용 파일 (여전히 지원되지만 주요 저장소는 아님):

- `~/.openclaw/credentials/oauth.json` (처음 사용할 때 `auth-profiles.json`에 가져옴)

위의 모든 것은 `$OPENCLAW_STATE_DIR` (상태 디렉토리 오버라이드)을 존중합니다. 전체 참조: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (구독 인증)

어느 기기에서든 `claude setup-token` 명령을 실행한 후, OpenClaw에 붙여 넣으세요:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 곳에서 토큰을 생성한 경우, 수동으로 붙여 넣으세요:

```bash
openclaw models auth paste-token --provider anthropic
```

검증:

```bash
openclaw models status
```

## OAuth 교환 (로그인 작동 방식)

OpenClaw의 대화형 로그인 흐름은 `@mariozechner/pi-ai`에 구현되어 있으며 마법사/명령어에 연결되어 있습니다.

### Anthropic (Claude Pro/Max) setup-token

흐름 모양:

1. `claude setup-token` 실행
2. OpenClaw에 토큰 붙여 넣기
3. 토큰 인증 프로필로 저장 (리프레시 없음)

마법사 경로는 `openclaw onboard` → 인증 선택 `setup-token` (Anthropic).

### OpenAI Codex (ChatGPT OAuth)

흐름 모양 (PKCE):

1. PKCE 검증자/챌린지 + 무작위 `state` 생성
2. `https://auth.openai.com/oauth/authorize?...` 열기
3. `http://127.0.0.1:1455/auth/callback`에서 콜백 잡기 시도
4. 콜백을 연결할 수 없거나 (원격/헤드리스인 경우), 리디렉션 URL/코드 붙여 넣기
5. `https://auth.openai.com/oauth/token`에서 교환
6. 액세스 토큰에서 `accountId` 추출하여 `{ access, refresh, expires, accountId }` 저장

마법사 경로는 `openclaw onboard` → 인증 선택 `openai-codex`.

## 리프레시 + 만료

프로필은 `expires` 타임스탬프를 저장합니다.

런타임 시:

- `expires`가 미래일 경우 → 저장된 액세스 토큰 사용
- 만료된 경우 → 리프레시 (파일 잠금 하에)하고 저장된 자격 증명을 덮어 씁니다

리프레시 흐름은 자동입니다; 일반적으로 토큰을 수동으로 관리할 필요는 없습니다.

## 여러 계정 (프로필) + 라우팅

두 가지 패턴:

### 1) 선호: 별도의 에이전트

"개인"과 "작업"이 절대 상호작용하지 않도록 하려면 고립된 에이전트 (별도 세션 + 자격 증명 + 작업 공간)를 사용하세요:

```bash
openclaw agents add work
openclaw agents add personal
```

그런 다음 에이전트별로 인증을 구성 (마법사)하고 채팅을 올바른 에이전트로 라우팅하세요.

### 2) 고급: 하나의 에이전트 내에서 다중 프로필

`auth-profiles.json`은 동일한 프로바이더에 대해 여러 프로필 ID를 지원합니다.

사용할 프로필 선택:

- 전역적으로 구성 순서에 따라 (`auth.order`)
- 세션별로 `/model ...@<profileId>`

예시 (세션 오버라이드):

- `/model Opus@anthropic:work`

어떤 프로필 ID가 있는지 확인하는 방법:

- `openclaw channels list --json` ( `auth[]` 표시)

관련 문서:

- [/concepts/model-failover](/concepts/model-failover) (회전 + 쿨다운 규칙)
- [/tools/slash-commands](/tools/slash-commands) (명령 표면)
