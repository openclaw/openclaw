---
summary: "Use Anthropic Claude via API keys or setup-token in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
  - You want setup-token instead of API keys
title: "Anthropic"
x-i18n:
  source_hash: a0e91ae9fc5b67ba458d995a7697013714be67d6a5115770355e8d43e95115e0
---

# 인류학(클로드)

Anthropic은 **Claude** 모델 계열을 구축하고 API를 통해 액세스를 제공합니다.
OpenClaw에서는 API 키 또는 **설정 토큰**으로 인증할 수 있습니다.

## 옵션 A: Anthropic API 키

**최적의 용도:** 표준 API 액세스 및 사용량 기반 청구.
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

OpenClaw는 Anthropic의 프롬프트 캐싱 기능을 지원합니다. 이는 **API 전용**입니다. 구독 인증은 캐시 설정을 따르지 않습니다.

### 구성

모델 구성에서 `cacheRetention` 매개변수를 사용하세요.

| 가치    | 캐시 기간 | 설명                        |
| ------- | --------- | --------------------------- |
| `none`  | 캐싱 없음 | 프롬프트 캐싱 비활성화      |
| `short` | 5분       | API 키 인증의 기본값        |
| `long`  | 1시간     | 확장 캐시(베타 플래그 필요) |

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

Anthropic API 키 인증을 사용할 때 OpenClaw는 모든 Anthropic 모델에 `cacheRetention: "short"`(5분 캐시)를 자동으로 적용합니다. 구성에서 `cacheRetention`를 명시적으로 설정하여 이를 무시할 수 있습니다.

### 레거시 매개변수

이전 `cacheControlTtl` 매개변수는 이전 버전과의 호환성을 위해 계속 지원됩니다.

- `"5m"`는 `short`에 매핑됩니다.
- `"1h"`는 `long`에 매핑됩니다.

새로운 `cacheRetention` 매개변수로 마이그레이션하는 것이 좋습니다.

OpenClaw에는 Anthropic API용 `extended-cache-ttl-2025-04-11` 베타 플래그가 포함되어 있습니다.
요청; 공급자 헤더를 재정의하는 경우 이를 유지하세요([/gateway/configuration](/gateway/configuration) 참조).

## 옵션 B: Claude 설정 토큰

**최적의 용도:** Claude 구독을 사용합니다.

### 설정 토큰을 얻을 수 있는 곳

설정 토큰은 Anthropic 콘솔이 아닌 **Claude Code CLI**에 의해 생성됩니다. **모든 머신**에서 실행할 수 있습니다.

```bash
claude setup-token
```

토큰을 OpenClaw(마법사: **Anthropic token(paste setup-token)**)에 붙여넣거나 게이트웨이 호스트에서 실행합니다.

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

### 구성 조각(설정 토큰)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 메모

- `claude setup-token`로 설정 토큰을 생성하여 붙여넣거나 게이트웨이 호스트에서 `openclaw models auth setup-token`를 실행합니다.
- Claude 구독에 "OAuth 토큰 새로 고침 실패..."가 표시되면 설정 토큰으로 다시 인증하세요. [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)을 참조하세요.
- 인증 세부정보 + 재사용 규칙은 [/concepts/oauth](/concepts/oauth)에 있습니다.

## 문제 해결

**401 오류/토큰이 갑자기 유효하지 않음**

- 클로드 구독 인증은 만료되거나 취소될 수 있습니다. `claude setup-token` 다시 실행
  **게이트웨이 호스트**에 붙여넣으세요.
- Claude CLI 로그인이 다른 시스템에 있는 경우 다음을 사용하십시오.
  `openclaw models auth paste-token --provider anthropic` 게이트웨이 호스트에 있습니다.

**"anthropic" 공급자에 대한 API 키를 찾을 수 없습니다**

- 인증은 **에이전트별**입니다. 새 에이전트는 기본 에이전트의 키를 상속하지 않습니다.
- 해당 에이전트에 대한 온보딩을 다시 실행하거나 설정 토큰/API 키를
  게이트웨이 호스트를 확인한 후 `openclaw models status`로 확인하세요.

**프로필 `anthropic:default`에 대한 자격 증명을 찾을 수 없습니다**

- `openclaw models status`를 실행하여 어떤 인증 프로필이 활성화되어 있는지 확인하세요.
- 온보딩을 다시 실행하거나 해당 프로필에 대한 설정 토큰/API 키를 붙여넣으세요.

**사용 가능한 인증 프로필이 없습니다(모두 대기 중이거나 사용할 수 없음)**

- `auth.unusableProfiles`에 대해 `openclaw models status --json`를 확인하세요.
- 다른 Anthropic 프로필을 추가하거나 쿨다운을 기다립니다.

추가 정보: [/gateway/문제 해결](/gateway/troubleshooting) 및 [/help/faq](/help/faq).
