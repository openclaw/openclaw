---
read_when:
    - OpenClaw에서 인류 모델을 사용하고 싶습니다.
    - API 키 대신 설정 토큰을 원합니다
summary: OpenClaw에서 API 키 또는 설정 토큰을 통해 Anthropic Claude를 사용하세요.
title: 인류학
x-i18n:
    generated_at: "2026-02-08T16:06:25Z"
    model: gtx
    provider: google-translate
    source_hash: a0e91ae9fc5b67ba458d995a7697013714be67d6a5115770355e8d43e95115e0
    source_path: providers/anthropic.md
    workflow: 15
---

# 인류학(클로드)

Anthropic은 다음을 구축합니다. **클로드** 모델 패밀리이며 API를 통해 액세스를 제공합니다.
OpenClaw에서는 API 키 또는 **설정 토큰**.

## 옵션 A: Anthropic API 키

**가장 적합한 대상:** 표준 API 액세스 및 사용량 기반 청구.
Anthropic 콘솔에서 API 키를 생성하세요.

### CLI 설정

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 구성 스니펫

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 프롬프트 캐싱(Anthropic API)

OpenClaw는 Anthropic의 프롬프트 캐싱 기능을 지원합니다. 이것은 **API 전용**; 구독 인증은 캐시 설정을 따르지 않습니다.

### 구성

사용 `cacheRetention` 모델 구성의 매개변수:

| Value   | Cache Duration | Description                         |
| ------- | -------------- | ----------------------------------- |
| `none`  | No caching     | Disable prompt caching              |
| `short` | 5 minutes      | Default for API Key auth            |
| `long`  | 1 hour         | Extended cache (requires beta flag) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### 기본값

Anthropic API Key 인증 사용 시 OpenClaw가 자동으로 적용됩니다. `cacheRetention: "short"` (5분 캐시) 모든 Anthropic 모델에 적용됩니다. 명시적으로 설정하여 이를 재정의할 수 있습니다. `cacheRetention` 귀하의 구성에서.

### 레거시 매개변수

나이가 많은 `cacheControlTtl` 이전 버전과의 호환성을 위해 매개변수가 계속 지원됩니다.

- `"5m"` 매핑 `short`
- `"1h"` 매핑 `long`

새 버전으로 마이그레이션하는 것이 좋습니다. `cacheRetention` 매개변수.

OpenClaw에는 다음이 포함됩니다. `extended-cache-ttl-2025-04-11` Anthropic API의 베타 플래그
요청; 공급자 헤더를 재정의하는 경우 이를 유지합니다(참조 [/게이트웨이/구성](/gateway/configuration)).

## 옵션 B: Claude 설정 토큰

**가장 적합한 대상:** Claude 구독을 사용하고 있습니다.

### 설정 토큰을 얻을 수 있는 곳

설정 토큰은 다음에 의해 생성됩니다. **클로드 코드 CLI**, Anthropic 콘솔이 아닙니다. 이것을 실행할 수 있습니다 **모든 기계**:

```bash
claude setup-token
```

토큰을 OpenClaw에 붙여넣습니다(마법사: **Anthropic 토큰(설정 토큰 붙여넣기)**) 또는 게이트웨이 호스트에서 실행합니다.

```bash
openclaw models auth setup-token --provider anthropic
```

다른 머신에서 토큰을 생성한 경우 붙여넣습니다.

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 설정(설정 토큰)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### 구성 스니펫(설정 토큰)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 메모

- 다음을 사용하여 설정 토큰을 생성합니다. `claude setup-token` 붙여넣거나 실행하세요. `openclaw models auth setup-token` 게이트웨이 호스트에서.
- Claude 구독에 "OAuth 토큰 새로 고침 실패..."가 표시되면 설정 토큰을 사용하여 다시 인증하세요. 보다 [/gateway/문제 해결#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- 인증 세부정보 + 재사용 규칙은 다음과 같습니다. [/개념/oauth](/concepts/oauth).

## 문제 해결

**401 오류/토큰이 갑자기 유효하지 않습니다.**

- Claude 구독 인증은 만료되거나 취소될 수 있습니다. 재실행 `claude setup-token`
  그리고 그것을 **게이트웨이 호스트**.
- Claude CLI 로그인이 다른 시스템에 있는 경우 다음을 사용하십시오.
  `openclaw models auth paste-token --provider anthropic` 게이트웨이 호스트에서.

**"anthropic" 공급자에 대한 API 키를 찾을 수 없습니다.**

- 인증은 **에이전트당**. 새 에이전트는 기본 에이전트의 키를 상속하지 않습니다.
- 해당 에이전트에 대한 온보딩을 다시 실행하거나 설정 토큰/API 키를
  게이트웨이 호스트를 확인한 다음 `openclaw models status`.

**프로필에 대한 자격 증명을 찾을 수 없습니다. `anthropic:default`**

- 달리다 `openclaw models status` 어떤 인증 프로필이 활성화되어 있는지 확인하세요.
- 온보딩을 다시 실행하거나 해당 프로필에 대한 설정 토큰/API 키를 붙여넣으세요.

**사용 가능한 인증 프로필 없음(모두 휴지 기간 중/사용할 수 없음)**

- 확인하다 `openclaw models status --json` ~을 위한 `auth.unusableProfiles`.
- 다른 Anthropic 프로필을 추가하거나 쿨다운을 기다리세요.

더: [/게이트웨이/문제 해결](/gateway/troubleshooting) 그리고 [/도움말/자주 묻는 질문](/help/faq).
