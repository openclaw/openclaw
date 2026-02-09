---
summary: "OpenClaw 에서 API 키 또는 setup-token 을 통해 Anthropic Claude 를 사용합니다"
read_when:
  - OpenClaw 에서 Anthropic 모델을 사용하려는 경우
  - API 키 대신 setup-token 을 사용하려는 경우
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic 은 **Claude** 모델 패밀리를 구축하고 API 를 통해 액세스를 제공합니다.
OpenClaw 에서는 API 키 또는 **setup-token** 으로 인증할 수 있습니다.

## 옵션 A: Anthropic API 키

**적합 대상:** 표준 API 액세스 및 사용량 기반 과금.
Anthropic Console 에서 API 키를 생성합니다.

### CLI 설정

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### 설정 스니펫

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 프롬프트 캐싱 (Anthropic API)

OpenClaw 는 Anthropic 의 프롬프트 캐싱 기능을 지원합니다. 이는 **API 전용**이며, 구독 인증은 캐시 설정을 적용하지 않습니다.

### 구성

모델 설정에서 `cacheRetention` 파라미터를 사용합니다:

| 값       | 캐시 지속 시간 | 설명                                   |
| ------- | -------- | ------------------------------------ |
| `none`  | 캐싱 없음    | 프롬프트 캐싱 비활성화                         |
| `short` | 5분       | API 키 인증의 기본값                        |
| `long`  | 1시간      | 확장 캐시 (베타 플래그 필요) |

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

Anthropic API 키 인증을 사용하는 경우, OpenClaw 는 모든 Anthropic 모델에 대해 자동으로 `cacheRetention: "short"` (5분 캐시) 를 적용합니다. 설정에서 `cacheRetention` 을 명시적으로 설정하여 이를 재정의할 수 있습니다.

### 레거시 파라미터

이전의 `cacheControlTtl` 파라미터는 하위 호환성을 위해 여전히 지원됩니다:

- `"5m"` 는 `short` 에 매핑됩니다
- `"1h"` 는 `long` 에 매핑됩니다

새로운 `cacheRetention` 파라미터로 마이그레이션하는 것을 권장합니다.

OpenClaw 는 Anthropic API 요청에 대해 `extended-cache-ttl-2025-04-11` 베타 플래그를 포함합니다. 프로바이더 헤더를 재정의하는 경우 이를 유지하십시오 (자세한 내용은 [/gateway/configuration](/gateway/configuration) 를 참고하십시오).

## 옵션 B: Claude setup-token

**적합 대상:** Claude 구독을 사용하는 경우.

### setup-token 을 얻는 방법

Setup-token 은 Anthropic Console 이 아니라 **Claude Code CLI** 에서 생성됩니다. 이는 **어떤 머신에서든** 실행할 수 있습니다:

```bash
claude setup-token
```

토큰을 OpenClaw 에 붙여넣거나 (마법사: **Anthropic token (paste setup-token)**), 게이트웨이 호스트에서 실행할 수 있습니다:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 머신에서 토큰을 생성한 경우, 붙여넣으십시오:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 설정 (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### 설정 스니펫 (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 참고 사항

- `claude setup-token` 으로 setup-token 을 생성하여 붙여넣거나, 게이트웨이 호스트에서 `openclaw models auth setup-token` 를 실행하십시오.
- Claude 구독에서 “OAuth token refresh failed …” 가 표시되면 setup-token 으로 다시 인증하십시오. [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription) 를 참고하십시오.
- 인증 세부 정보 및 재사용 규칙은 [/concepts/oauth](/concepts/oauth) 에 있습니다.

## 문제 해결

**401 오류 / 토큰이 갑자기 유효하지 않음**

- Claude 구독 인증은 만료되거나 취소될 수 있습니다. `claude setup-token` 를 다시 실행하여
  **게이트웨이 호스트**에 붙여넣으십시오.
- Claude CLI 로그인이 다른 머신에 있는 경우,
  게이트웨이 호스트에서 `openclaw models auth paste-token --provider anthropic` 를 사용하십시오.

**프로바이더 "anthropic" 에 대한 API 키를 찾을 수 없음**

- 인증은 **에이전트별**입니다. 새 에이전트는 메인 에이전트의 키를 상속하지 않습니다.
- 해당 에이전트에 대해 온보딩을 다시 실행하거나, 게이트웨이 호스트에 setup-token / API 키를 붙여넣은 다음
  `openclaw models status` 로 확인하십시오.

**프로파일 `anthropic:default` 에 대한 자격 증명을 찾을 수 없음**

- `openclaw models status` 를 실행하여 어떤 인증 프로파일이 활성화되어 있는지 확인하십시오.
- 온보딩을 다시 실행하거나, 해당 프로파일에 setup-token / API 키를 붙여넣으십시오.

**사용 가능한 인증 프로파일이 없음 (모두 쿨다운/사용 불가)**

- `openclaw models status --json` 에서 `auth.unusableProfiles` 를 확인하십시오.
- 다른 Anthropic 프로파일을 추가하거나 쿨다운이 끝날 때까지 기다리십시오.

추가 정보: [/gateway/troubleshooting](/gateway/troubleshooting) 및 [/help/faq](/help/faq).
