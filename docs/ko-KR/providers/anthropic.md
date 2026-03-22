---
summary: "OpenClaw 에서 API 키 또는 setup-token 을 사용하여 Anthropic Claude 를 이용하는 방법"
read_when:
  - OpenClaw 에서 Anthropic 모델을 사용하고 싶을 때
  - API 키 대신 setup-token 을 사용하고 싶을 때
title: "Anthropic"
x-i18n:
  source_path: docs/providers/anthropic.md
---

# Anthropic (Claude)

Anthropic 은 **Claude** 모델 패밀리를 개발하며 API 를 통해 액세스를 제공합니다.
OpenClaw 에서는 API 키 또는 **setup-token** 으로 인증할 수 있습니다.

## 옵션 A: Anthropic API 키

**적합한 경우:** 표준 API 액세스 및 사용량 기반 과금.
Anthropic Console 에서 API 키를 생성하세요.

### CLI 설정

```bash
openclaw onboard
# 선택: Anthropic API key

# 또는 비대화형으로
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 설정 스니펫

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Thinking 기본값 (Claude 4.6)

- Anthropic Claude 4.6 모델은 명시적인 thinking 레벨이 설정되지 않은 경우 OpenClaw 에서 기본적으로 `adaptive` thinking 을 사용합니다.
- 메시지별로 (`/think:<level>`) 또는 모델 파라미터에서 재정의할 수 있습니다:
  `agents.defaults.models["anthropic/<model>"].params.thinking`.
- 관련 Anthropic 문서:
  - [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
  - [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

## Fast 모드 (Anthropic API)

OpenClaw 의 공유 `/fast` 토글은 직접 Anthropic API 키 트래픽도 지원합니다.

- `/fast on` 은 `service_tier: "auto"` 에 매핑됩니다
- `/fast off` 는 `service_tier: "standard_only"` 에 매핑됩니다
- 설정 기본값:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-6": {
          params: { fastMode: true },
        },
      },
    },
  },
}
```

중요한 제한 사항:

- 이것은 **API 키 전용** 입니다. Anthropic setup-token / OAuth 인증은 OpenClaw fast-mode 티어 주입을 적용하지 않습니다.
- OpenClaw 는 직접 `api.anthropic.com` 요청에 대해서만 Anthropic 서비스 티어를 주입합니다. `anthropic/*` 를 프록시나 게이트웨이를 통해 라우팅하는 경우 `/fast` 는 `service_tier` 를 변경하지 않습니다.
- Anthropic 은 응답의 `usage.service_tier` 에서 유효 티어를 보고합니다. Priority Tier 용량이 없는 계정에서는 `service_tier: "auto"` 가 여전히 `standard` 로 해석될 수 있습니다.

## 프롬프트 캐싱 (Anthropic API)

OpenClaw 는 Anthropic 의 프롬프트 캐싱 기능을 지원합니다. 이것은 **API 전용** 이며, 구독 인증은 캐시 설정을 적용하지 않습니다.

### 설정

모델 설정에서 `cacheRetention` 파라미터를 사용하세요:

| 값      | 캐시 지속 시간 | 설명                         |
| ------- | -------------- | ---------------------------- |
| `none`  | 캐싱 없음      | 프롬프트 캐싱 비활성화       |
| `short` | 5 분           | API 키 인증의 기본값         |
| `long`  | 1 시간         | 확장 캐시 (베타 플래그 필요) |

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

Anthropic API 키 인증을 사용할 때, OpenClaw 는 모든 Anthropic 모델에 자동으로 `cacheRetention: "short"` (5 분 캐시) 를 적용합니다. 설정에서 명시적으로 `cacheRetention` 을 설정하여 재정의할 수 있습니다.

### 에이전트별 cacheRetention 재정의

모델 수준의 파라미터를 기본값으로 사용한 다음, `agents.list[].params` 를 통해 특정 에이전트를 재정의하세요.

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" }, // 대부분의 에이전트에 대한 기본값
        },
      },
    },
    list: [
      { id: "research", default: true },
      { id: "alerts", params: { cacheRetention: "none" } }, // 이 에이전트에만 적용되는 재정의
    ],
  },
}
```

캐시 관련 파라미터의 설정 병합 순서:

1. `agents.defaults.models["provider/model"].params`
2. `agents.list[].params` (일치하는 `id`, 키별 재정의)

이를 통해 하나의 에이전트는 장기 캐시를 유지하면서 동일 모델의 다른 에이전트는 버스트성/낮은 재사용 트래픽에서 쓰기 비용을 피하기 위해 캐싱을 비활성화할 수 있습니다.

### Bedrock Claude 참고 사항

- Bedrock 의 Anthropic Claude 모델 (`amazon-bedrock/*anthropic.claude*`) 은 설정 시 `cacheRetention` 패스스루를 허용합니다.
- Bedrock 의 비 Anthropic 모델은 런타임에 `cacheRetention: "none"` 으로 강제됩니다.
- Anthropic API 키 스마트 기본값은 명시적 값이 설정되지 않은 경우 Claude-on-Bedrock 모델 참조에도 `cacheRetention: "short"` 를 시드합니다.

### 레거시 파라미터

이전 `cacheControlTtl` 파라미터는 하위 호환성을 위해 여전히 지원됩니다:

- `"5m"` 은 `short` 에 매핑됩니다
- `"1h"` 은 `long` 에 매핑됩니다

새로운 `cacheRetention` 파라미터로 마이그레이션하는 것을 권장합니다.

OpenClaw 는 Anthropic API 요청에 `extended-cache-ttl-2025-04-11` 베타 플래그를 포함합니다. 프로바이더 헤더를 재정의하는 경우 이를 유지하세요 ([/gateway/configuration](/gateway/configuration) 참조).

## 1M 컨텍스트 윈도우 (Anthropic 베타)

Anthropic 의 1M 컨텍스트 윈도우는 베타 게이트가 적용되어 있습니다. OpenClaw 에서 지원되는 Opus/Sonnet 모델에 대해 `params.context1m: true` 로 모델별로 활성화하세요.

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

OpenClaw 는 이를 Anthropic 요청의 `anthropic-beta: context-1m-2025-08-07` 로 매핑합니다.

이것은 해당 모델에 대해 `params.context1m` 이 명시적으로 `true` 로 설정된 경우에만 활성화됩니다.

요구 사항: Anthropic 이 해당 자격 증명에서 long-context 사용을 허용해야 합니다 (일반적으로 API 키 과금 또는 Extra Usage 가 활성화된 구독 계정). 그렇지 않으면 Anthropic 이 다음을 반환합니다:
`HTTP 429: rate_limit_error: Extra usage is required for long context requests`.

참고: Anthropic 은 현재 OAuth/구독 토큰 (`sk-ant-oat-*`) 사용 시 `context-1m-*` 베타 요청을 거부합니다. OpenClaw 는 OAuth 인증에 대해 context1m 베타 헤더를 자동으로 건너뛰고 필요한 OAuth 베타를 유지합니다.

## 옵션 B: Claude setup-token

**적합한 경우:** Claude 구독 사용.

### setup-token 을 얻는 방법

setup-token 은 Anthropic Console 이 아닌 **Claude Code CLI** 에서 생성됩니다. **어떤 머신에서든** 실행할 수 있습니다:

```bash
claude setup-token
```

토큰을 OpenClaw 에 붙여넣으세요 (마법사: **Anthropic token (paste setup-token)**), 또는 Gateway 호스트에서 실행하세요:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 머신에서 토큰을 생성한 경우, 붙여넣으세요:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 설정 (setup-token)

```bash
# 설정 중 setup-token 붙여넣기
openclaw onboard --auth-choice setup-token
```

### 설정 스니펫 (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 참고 사항

- `claude setup-token` 으로 setup-token 을 생성하여 붙여넣거나, Gateway 호스트에서 `openclaw models auth setup-token` 을 실행하세요.
- Claude 구독에서 "OAuth token refresh failed ..." 가 표시되면, setup-token 으로 다시 인증하세요. [/gateway/troubleshooting](/gateway/troubleshooting) 을 참조하세요.
- 인증 세부 사항 및 재사용 규칙은 [/concepts/oauth](/concepts/oauth) 에 있습니다.

## 문제 해결

**401 오류 / 토큰이 갑자기 무효화됨**

- Claude 구독 인증은 만료되거나 취소될 수 있습니다. `claude setup-token` 을 다시 실행하고
  **Gateway 호스트** 에 붙여넣으세요.
- Claude CLI 로그인이 다른 머신에 있는 경우, Gateway 호스트에서
  `openclaw models auth paste-token --provider anthropic` 을 사용하세요.

**No API key found for provider "anthropic"**

- 인증은 **에이전트별** 입니다. 새 에이전트는 메인 에이전트의 키를 상속하지 않습니다.
- 해당 에이전트에 대해 온보딩을 다시 실행하거나, Gateway 호스트에서 setup-token / API 키를
  붙여넣은 후 `openclaw models status` 로 확인하세요.

**No credentials found for profile `anthropic:default`**

- `openclaw models status` 를 실행하여 어떤 인증 프로필이 활성화되어 있는지 확인하세요.
- 온보딩을 다시 실행하거나, 해당 프로필에 대해 setup-token / API 키를 붙여넣으세요.

**No available auth profile (all in cooldown/unavailable)**

- `openclaw models status --json` 에서 `auth.unusableProfiles` 를 확인하세요.
- 다른 Anthropic 프로필을 추가하거나 쿨다운을 기다리세요.

자세한 내용: [/gateway/troubleshooting](/gateway/troubleshooting) 및 [/help/faq](/help/faq).
