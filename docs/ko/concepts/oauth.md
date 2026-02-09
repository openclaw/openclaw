---
summary: "OpenClaw 의 OAuth: 토큰 교환, 저장, 그리고 다중 계정 패턴"
read_when:
  - OpenClaw OAuth 를 엔드투엔드로 이해하고 싶을 때
  - 토큰 무효화 / 로그아웃 문제를 겪었을 때
  - setup-token 또는 OAuth 인증 플로우가 필요할 때
  - 다중 계정 또는 프로필 라우팅이 필요할 때
title: "OAuth"
---

# OAuth

OpenClaw 는 이를 제공하는 프로바이더에 대해 OAuth 를 통한 '구독 인증(subscription auth)'을 지원합니다(특히 **OpenAI Codex (ChatGPT OAuth)**). Anthropic 구독의 경우 **setup-token** 플로우를 사용하십시오. 이 페이지에서는 다음을 설명합니다.

- OAuth **토큰 교환**이 작동하는 방식(PKCE)
- 토큰이 **저장되는 위치**(및 그 이유)
- **다중 계정**을 처리하는 방법(프로필 + 세션별 오버라이드)

OpenClaw 는 자체 OAuth 또는 API 키 플로우를 제공하는 **프로바이더 플러그인**도 지원합니다. 다음으로 실행하십시오.

```bash
openclaw models auth login --provider <id>
```

## 토큰 싱크(token sink)(존재 이유)

OAuth 프로바이더는 로그인/리프레시 플로우 중에 **새 리프레시 토큰**을 발급하는 경우가 일반적입니다. 일부 프로바이더(또는 OAuth 클라이언트)는 동일한 사용자/앱에 대해 새 토큰이 발급되면 이전 리프레시 토큰을 무효화할 수 있습니다.

실제 증상:

- OpenClaw _그리고_ Claude Code / Codex CLI 를 통해 로그인 → 이후 무작위로 한쪽이 '로그아웃'됨

이를 줄이기 위해 OpenClaw 는 `auth-profiles.json` 를 **토큰 싱크**로 취급합니다.

- 런타임은 **하나의 위치**에서 자격 증명을 읽습니다.
- 여러 프로필을 유지하고 이를 결정적으로 라우팅할 수 있습니다.

## 저장소(토큰이 위치하는 곳)

시크릿은 **에이전트별**로 저장됩니다.

- 인증 프로필(OAuth + API 키): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 런타임 캐시(자동 관리; 편집하지 마십시오): `~/.openclaw/agents/<agentId>/agent/auth.json`

레거시 가져오기 전용 파일(여전히 지원되지만, 메인 저장소는 아님):

- `~/.openclaw/credentials/oauth.json`(첫 사용 시 `auth-profiles.json` 로 가져옴)

위의 모든 항목은 `$OPENCLAW_STATE_DIR`(상태 디렉토리 오버라이드)도 존중합니다. 전체 참조: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token(구독 인증)

어느 머신에서든 `claude setup-token` 를 실행한 다음, OpenClaw 에 붙여넣으십시오.

```bash
openclaw models auth setup-token --provider anthropic
```

다른 곳에서 토큰을 생성했다면 수동으로 붙여넣으십시오.

```bash
openclaw models auth paste-token --provider anthropic
```

확인:

```bash
openclaw models status
```

## OAuth 교환(로그인이 작동하는 방식)

OpenClaw 의 대화형 로그인 플로우는 `@mariozechner/pi-ai` 에 구현되어 있으며, 마법사/명령에 연결되어 있습니다.

### Anthropic(Claude Pro/Max) setup-token

플로우 형태:

1. `claude setup-token` 실행
2. 토큰을 OpenClaw 에 붙여넣기
3. 토큰 인증 프로필로 저장(리프레시 없음)

마법사 경로는 `openclaw onboard` → 인증 선택 `setup-token`(Anthropic)입니다.

### OpenAI Codex(ChatGPT OAuth)

플로우 형태(PKCE):

1. PKCE verifier/challenge + 랜덤 `state` 생성
2. `https://auth.openai.com/oauth/authorize?...` 열기
3. `http://127.0.0.1:1455/auth/callback` 에서 콜백 캡처 시도
4. 콜백을 바인딩할 수 없거나 원격/헤드리스 환경인 경우, 리디렉트 URL/코드를 붙여넣기
5. `https://auth.openai.com/oauth/token` 에서 교환
6. 액세스 토큰에서 `accountId` 추출 후 `{ access, refresh, expires, accountId }` 저장

마법사 경로는 `openclaw onboard` → 인증 선택 `openai-codex` 입니다.

## 리프레시 + 만료

프로필에는 `expires` 타임스탬프가 저장됩니다.

런타임에서:

- `expires` 가 미래라면 → 저장된 액세스 토큰 사용
- 만료된 경우 → (파일 락 하에) 리프레시하고 저장된 자격 증명을 덮어씀

리프레시 플로우는 자동으로 수행되며, 일반적으로 토큰을 수동으로 관리할 필요는 없습니다.

## 다중 계정(프로필) + 라우팅

두 가지 패턴이 있습니다.

### 1. 권장: 분리된 에이전트

'개인'과 '업무'가 절대 상호작용하지 않게 하려면, 격리된 에이전트(분리된 세션 + 자격 증명 + 워크스페이스)를 사용하십시오.

```bash
openclaw agents add work
openclaw agents add personal
```

그런 다음 에이전트별로 인증을 구성(마법사)하고, 채팅을 올바른 에이전트로 라우팅하십시오.

### 2. 고급: 하나의 에이전트에 여러 프로필

`auth-profiles.json` 는 동일한 프로바이더에 대해 여러 프로필 ID 를 지원합니다.

사용할 프로필을 선택하는 방법:

- 설정 순서를 통한 전역 선택(`auth.order`)
- 세션별로 `/model ...@<profileId>` 를 통한 선택

예시(세션 오버라이드):

- `/model Opus@anthropic:work`

존재하는 프로필 ID 를 확인하는 방법:

- `openclaw channels list --json`(`auth[]` 표시)

관련 문서:

- [/concepts/model-failover](/concepts/model-failover)(로테이션 + 쿨다운 규칙)
- [/tools/slash-commands](/tools/slash-commands)(명령 표면)
