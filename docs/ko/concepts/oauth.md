---
read_when:
    - OpenClaw OAuth 엔드투엔드를 이해하고 싶습니다.
    - 토큰 무효화/로그아웃 문제가 발생했습니다.
    - 설정 토큰 또는 OAuth 인증 흐름을 원합니다.
    - 여러 계정 또는 프로필 라우팅을 원합니다.
summary: 'OpenClaw의 OAuth: 토큰 교환, 저장 및 다중 계정 패턴'
title: OAuth
x-i18n:
    generated_at: "2026-02-08T15:54:40Z"
    model: gtx
    provider: google-translate
    source_hash: af714bdadc4a89295a18da1eba5f5b857c8d533ebabe9b0758b722fe60c36124
    source_path: concepts/oauth.md
    workflow: 15
---

# OAuth

OpenClaw는 이를 제공하는 제공업체에 대해 OAuth를 통해 "구독 인증"을 지원합니다(특히 **OpenAI 코덱스(ChatGPT OAuth)**). Anthropic 구독의 경우 **설정 토큰** 흐름. 이 페이지에서는 다음을 설명합니다.

- OAuth는 어떻게 **토큰 교환** 작품 (PKCE)
- 토큰이 있는 곳 **저장됨** (그리고 왜)
- 처리하는 방법 **여러 계정** (프로필 + 세션별 재정의)

OpenClaw도 지원합니다. **공급자 플러그인** 자체 OAuth 또는 API 키를 제공하는 경우
흐른다. 다음을 통해 실행하세요.

```bash
openclaw models auth login --provider <id>
```

## 토큰 싱크(존재 이유)

OAuth 제공자는 일반적으로 **새로운 새로 고침 토큰** 로그인/새로고침 흐름 중. 일부 공급자(또는 OAuth 클라이언트)는 동일한 사용자/앱에 대해 새 토큰이 발급될 때 이전 새로 고침 토큰을 무효화할 수 있습니다.

실제 증상:

- OpenClaw를 통해 로그인 _그리고_ Claude Code / Codex CLI를 통해 → 그 중 하나가 나중에 무작위로 "로그아웃"됩니다.

이를 줄이기 위해 OpenClaw는 다음을 처리합니다. `auth-profiles.json` 로서 **토큰 싱크**:

- 런타임은 다음에서 자격 증명을 읽습니다. **한 곳**
- 여러 프로필을 유지하고 결정적으로 라우팅할 수 있습니다.

## 저장소(토큰이 있는 곳)

비밀이 저장됩니다 **에이전트별**:

- 인증 프로필(OAuth + API 키): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 런타임 캐시(자동으로 관리되며 편집하지 않음): `~/.openclaw/agents/<agentId>/agent/auth.json`

레거시 가져오기 전용 파일(여전히 지원되지만 기본 스토어는 지원되지 않음):

- `~/.openclaw/credentials/oauth.json` (다음으로 가져옴 `auth-profiles.json` 처음 사용할 때)

위의 모든 내용도 존중합니다. `$OPENCLAW_STATE_DIR` (상태 디렉토리 재정의). 전체 참조: [/게이트웨이/구성](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic 설정 토큰(구독 인증)

달리다 `claude setup-token` 아무 머신에서나 OpenClaw에 붙여넣습니다.

```bash
openclaw models auth setup-token --provider anthropic
```

다른 곳에서 토큰을 생성한 경우 수동으로 붙여넣습니다.

```bash
openclaw models auth paste-token --provider anthropic
```

확인하다:

```bash
openclaw models status
```

## OAuth 교환(로그인 작동 방식)

OpenClaw의 대화형 로그인 흐름은 다음에서 구현됩니다. `@mariozechner/pi-ai` 마법사/명령에 연결됩니다.

### Anthropic(Claude Pro/Max) 설정 토큰

흐름 모양:

1. 달리다 `claude setup-token`
2. OpenClaw에 토큰을 붙여넣으세요.
3. 토큰 인증 프로필로 저장(새로 고침 없음)

마법사 경로는 `openclaw onboard` → 인증 선택 `setup-token` (인류).

### OpenAI 코덱스(ChatGPT OAuth)

흐름 형태(PKCE):

1. PKCE 검증자/챌린지 + 무작위 생성 `state`
2. 열려 있는 `https://auth.openai.com/oauth/authorize?...`
3. 콜백 캡처를 시도합니다. `http://127.0.0.1:1455/auth/callback`
4. 콜백을 바인딩할 수 없는 경우(또는 원격/헤드리스인 경우) 리디렉션 URL/코드를 붙여넣으세요.
5. 에서 교환하다 `https://auth.openai.com/oauth/token`
6. 발췌 `accountId` 액세스 토큰 및 저장소에서 `{ access, refresh, expires, accountId }`

마법사 경로는 `openclaw onboard` → 인증 선택 `openai-codex`.

## 새로 고침 + 만료

프로필은 `expires` 타임스탬프.

런타임 시:

- 만약에 `expires` 미래에 있음 → 저장된 액세스 토큰을 사용
- 만료된 경우 → 새로 고치고(파일 잠금 상태에서) 저장된 자격 증명을 덮어씁니다.

새로 고침 흐름은 자동입니다. 일반적으로 토큰을 수동으로 관리할 필요는 없습니다.

## 다중 계정(프로필) + 라우팅

두 가지 패턴:

### 1) 선호 : 별도의 대리인

"개인"과 "업무"가 상호 작용하지 않도록 하려면 격리된 에이전트(별도의 세션 + 자격 증명 + 작업 영역)를 사용하세요.

```bash
openclaw agents add work
openclaw agents add personal
```

그런 다음 에이전트별 인증(마법사)을 구성하고 채팅을 올바른 에이전트에게 라우팅합니다.

### 2) 고급: 하나의 에이전트에 여러 프로필이 있음

`auth-profiles.json` 동일한 공급자에 대해 여러 프로필 ID를 지원합니다.

사용할 프로필을 선택하세요.

- 구성 순서를 통해 전역적으로(`auth.order`)
- 세션별 `/model ...@<profileId>`

예(세션 재정의):

- `/model Opus@anthropic:work`

어떤 프로필 ID가 있는지 확인하는 방법:

- `openclaw channels list --json` (쇼 `auth[]`)

관련 문서:

- [/개념/모델-장애 조치](/concepts/model-failover) (로테이션 + 쿨다운 규칙)
- [/tools/슬래시 명령](/tools/slash-commands) (명령 표면)
