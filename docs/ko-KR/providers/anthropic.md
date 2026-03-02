---
summary: "OpenClaw에서 API 키 또는 setup-token으로 Anthropic Claude를 사용합니다"
read_when:
  - OpenClaw에서 Anthropic 모델을 사용하고 싶을 때
  - API 키 대신 setup-token을 원할 때
title: "Anthropic"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/anthropic.md"
  workflow: 15
---

# Anthropic (Claude)

Anthropic은 **Claude** 모델 제품군을 구축하고 API를 통해 액세스를 제공합니다.
OpenClaw에서 API 키 또는 **setup-token**으로 인증할 수 있습니다.

## 옵션 A: Anthropic API 키

**최고:** 표준 API 액세스 및 사용량 기반 청구.
Anthropic 콘솔에서 API 키를 생성합니다.

### CLI 설정

```bash
openclaw onboard
# 선택: Anthropic API 키

# 또는 비대화형
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 구성 스니펫

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 프롬프트 캐싱 (Anthropic API)

OpenClaw는 Anthropic의 프롬프트 캐싱 기능을 지원합니다. 이는 **API 전용**입니다. 구독 인증은 캐시 설정을 허용하지 않습니다.

### 구성

모델 구성에서 `cacheRetention` 매개변수를 사용합니다:

| 값      | 캐시 기간 | 설명                         |
| ------- | --------- | ---------------------------- |
| `none`  | 캐싱 없음 | 프롬프트 캐싱 비활성화       |
| `short` | 5분       | API 키 인증의 기본값         |
| `long`  | 1시간     | 확장 캐시 (베타 플래그 필요) |

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

Anthropic API 키 인증을 사용할 때 OpenClaw는 모든 Anthropic 모델에 대해 자동으로 `cacheRetention: "short"` (5분 캐시)를 적용합니다. 구성에서 명시적으로 `cacheRetention`을 설정하여 재정의할 수 있습니다.

### 에이전트별 cacheRetention 재정의

모델 수준 매개변수를 기준선으로 사용한 다음 `agents.list[].params`를 통해 특정 에이전트를 재정의합니다.

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" }, // 대부분의 에이전트의 기준선
        },
      },
    },
    list: [
      { id: "research", default: true },
      { id: "alerts", params: { cacheRetention: "none" } }, // 이 에이전트만 재정의
    ],
  },
}
```

캐시 관련 매개변수의 구성 병합 순서:

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params` (일치하는 `id`, 키로 재정의)

이를 통해 한 에이전트는 장기 캐시를 유지하고 같은 모델의 다른 에이전트는 폭발적/낮은 재사용 트래픽에 대한 쓰기 비용을 피하기 위해 캐싱을 비활성화할 수 있습니다.

### Bedrock Claude 참고사항

- Bedrock의 Anthropic Claude 모델(`amazon-bedrock/*anthropic.claude*`)은 구성할 때 `cacheRetention` 통과를 허용합니다.
- Bedrock의 비 Anthropic 모델은 런타임에 `cacheRetention: "none"`으로 강제됩니다.
- Anthropic API 키 스마트 기본값은 명시적 값이 설정되지 않았을 때 Claude-on-Bedrock 모델 참조에 대해 `cacheRetention: "short"`도 시드합니다.

### 레거시 매개변수

이전 `cacheControlTtl` 매개변수는 하위 호환성을 위해 여전히 지원됩니다:

- `"5m"`은 `short`로 매핑됩니다
- `"1h"`은 `long`으로 매핑됩니다

새로운 `cacheRetention` 매개변수로 마이그레이션하는 것이 좋습니다.

OpenClaw는 Anthropic API 요청을 위해 `extended-cache-ttl-2025-04-11` 베타 플래그를 포함합니다. 제공자 헤더를 재정의하는 경우 유지합니다([/gateway/configuration](/gateway/configuration) 참조).

## 1M 컨텍스트 창 (Anthropic 베타)

Anthropic의 1M 컨텍스트 창은 베타 게이트입니다. OpenClaw에서 지원되는 Opus/Sonnet 모델에 대해 모델당 `params.context1m: true`로 활성화합니다.

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { context1m: true },
        },
      },
    },
  },
}
```

OpenClaw는 이를 Anthropic 요청의 `anthropic-beta: context-1m-2025-08-07`로 매핑합니다.

이는 해당 모델에 대해 `params.context1m`이 명시적으로 `true`로 설정된 경우에만 활성화됩니다.

요구사항: Anthropic은 해당 자격증명에 대해 장문 컨텍스트 사용을 허용해야 합니다(일반적으로 API 키 청구 또는 추가 사용량이 활성화된 구독 계정). 그렇지 않으면 Anthropic은 다음을 반환합니다:
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`.

참고: Anthropic은 현재 OAuth/구독 토큰(`sk-ant-oat-*`)을 사용할 때 `context-1m-*` 베타 요청을 거부합니다. OpenClaw는 OAuth 인증에 대해 자동으로 context1m 베타 헤더를 건너뛰고 필요한 OAuth 베타를 유지합니다.

## 옵션 B: Claude setup-token

**최고:** Claude 구독 사용.

### setup-token을 얻는 위치

Setup-token은 Anthropic 콘솔이 아닌 **Claude Code CLI**로 생성됩니다. 모든 머신에서 실행할 수 있습니다:

```bash
claude setup-token
```

OpenClaw에 토큰을 붙여넣습니다(마법사: **Anthropic token (setup-token 붙여넣기)**) 또는 게이트웨이 호스트에서 실행합니다:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 머신에서 토큰을 생성한 경우 붙여넣습니다:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 설정 (setup-token)

```bash
# 온보딩 중에 setup-token 붙여넣기
openclaw onboard --auth-choice setup-token
```

### 구성 스니펫 (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 참고

- `claude setup-token`으로 setup-token을 생성한 후 붙여넣거나, 게이트웨이 호스트에서 `openclaw models auth setup-token`을 실행합니다.
- Claude 구독에서 "OAuth token refresh failed …"를 보면 setup-token으로 다시 인증합니다. [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)를 참조하세요.
- 인증 세부사항 및 재사용 규칙은 [/concepts/oauth](/concepts/oauth)에 있습니다.

## 문제 해결

**401 오류 / 토큰 갑자기 무효**

- Claude 구독 인증은 만료되거나 취소될 수 있습니다. `claude setup-token`을 다시 실행하고 **게이트웨이 호스트**에 붙여넣습니다.
- Claude CLI 로그인이 다른 머신에 있으면 게이트웨이 호스트에서 `openclaw models auth paste-token --provider anthropic`을 사용합니다.

**"anthropic" 제공업체를 위해 API 키를 찾을 수 없습니다**

- 인증은 **에이전트별**입니다. 새 에이전트는 주 에이전트의 키를 상속하지 않습니다.
- 해당 에이전트에 대해 온보딩을 다시 실행하거나, 게이트웨이 호스트에 setup-token/API 키를 붙여넣은 후 `openclaw models status`로 확인합니다.

**프로필 `anthropic:default`에 대한 자격증명을 찾을 수 없습니다**

- `openclaw models status`를 실행하여 활성 인증 프로필을 확인합니다.
- 온보딩을 다시 실행하거나, 해당 프로필에 대해 setup-token/API 키를 붙여넣습니다.

**사용 가능한 인증 프로필 없음 (모두 쿨다운/사용 불가)**

- `openclaw models status --json`에서 `auth.unusableProfiles`를 확인합니다.
- 다른 Anthropic 프로필을 추가하거나 쿨다운을 기다립니다.

더 많은 정보: [/gateway/troubleshooting](/gateway/troubleshooting) 및 [/help/faq](/help/faq).
