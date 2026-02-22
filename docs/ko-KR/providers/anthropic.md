---
summary: "OpenClaw에서 API 키 또는 설정 토큰을 통해 Anthropic Claude 사용"
read_when:
  - OpenClaw에서 Anthropic 모델을 사용하고 싶습니다
  - API 키 대신 설정 토큰을 원합니다
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic은 **Claude** 모델 계열을 개발하고 API를 통해 접근을 제공합니다. OpenClaw에서는 API 키 또는 **설정 토큰**으로 인증할 수 있습니다.

## Option A: Anthropic API key

**적합한 사용 사례:** 표준 API 액세스 및 사용량 기반 청구.
Anthropic 콘솔에서 API 키를 생성하세요.

### CLI 설정

```bash
openclaw onboard
# 선택: Anthropic API key

# 또는 비대화식
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

OpenClaw는 Anthropic의 프롬프트 캐싱 기능을 지원합니다. 이는 **API 전용**입니다. 구독 인증은 캐시 설정을 인정하지 않습니다.

### 구성

모델 설정에서 `cacheRetention` 매개변수를 사용하세요:

| 값      | 캐시 기간    | 설명                               |
| ------- | ------------ | ----------------------------------- |
| `none`  | 캐싱 없음    | 프롬프트 캐싱 비활성화              |
| `short` | 5분          | API 키 인증의 기본값                |
| `long`  | 1시간        | 확장된 캐시 (베타 플래그 필요)      |

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

Anthropic API 키 인증을 사용할 때, OpenClaw는 모든 Anthropic 모델에 대해 자동으로 `cacheRetention: "short"`(5분 캐시)를 적용합니다. 설정에서 명시적으로 `cacheRetention`을 설정하여 이를 재정의할 수 있습니다.

### 레거시 매개변수

이전의 `cacheControlTtl` 매개변수는 하위 호환성을 위해 여전히 지원됩니다:

- `"5m"`은 `short`와 매핑됩니다
- `"1h"`은 `long`과 매핑됩니다

새로운 `cacheRetention` 매개변수로의 마이그레이션을 권장합니다.

OpenClaw에는 Anthropic API 요청을 위한 `extended-cache-ttl-2025-04-11` 베타 플래그가 포함되어 있습니다. 제공자 헤더를 재정의할 경우 이를 유지하세요(자세한 내용은 [/gateway/configuration](/ko-KR/gateway/configuration) 참조).

## 1M 컨텍스트 윈도우 (Anthropic 베타)

Anthropic의 1M 컨텍스트 윈도우는 베타로 제한됩니다. OpenClaw에서는 지원되는 Opus/Sonnet 모델에 대해 `params.context1m: true`로 모델별로 활성화하세요.

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

OpenClaw는 이를 Anthropic 요청에서 `anthropic-beta: context-1m-2025-08-07`로 매핑합니다.

## Option B: Claude 설정 토큰

**적합한 사용 사례:** Claude 구독을 사용할 때.

### 설정 토큰을 얻는 방법

설정 토큰은 **Claude Code CLI**에서 생성되며, Anthropic 콘솔에서는 생성되지 않습니다. **어떤 기계에서든** 이 명령을 실행할 수 있습니다:

```bash
claude setup-token
```

토큰을 OpenClaw에 붙여 넣거나(마법사: **Anthropic token (paste setup-token)**), 게이트웨이 호스트에서 실행하세요:

```bash
openclaw models auth setup-token --provider anthropic
```

다른 기계에서 토큰을 생성한 경우, 붙여넣기:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI 설정 (설정 토큰)

```bash
# 온보딩 중에 설정 토큰을 붙여넣습니다
openclaw onboard --auth-choice setup-token
```

### 설정 스니펫 (설정 토큰)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## 주의사항

- `claude setup-token`으로 설정 토큰을 생성하고 붙여넣거나, 게이트웨이 호스트에서 `openclaw models auth setup-token`을 실행하세요.
- Claude 구독에서 “OAuth token refresh failed …” 메시지가 표시되면, 설정 토큰으로 다시 인증하세요. [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/ko-KR/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription)를 참조하세요.
- 인증 세부사항 및 재사용 규칙은 [/concepts/oauth](/ko-KR/concepts/oauth)에 있습니다.

## 문제 해결

**401 오류 / 토큰이 갑자기 무효화됨**

- Claude 구독 인증은 만료되거나 취소될 수 있습니다. `claude setup-token`을 다시 실행하고 게이트웨이 호스트에 붙여넣으세요.
- 다른 기계에서 Claude CLI에 로그인한 경우, 게이트웨이 호스트에서 `openclaw models auth paste-token --provider anthropic`을 사용하세요.

**프로바이더 "anthropic"에 대한 API 키가 발견되지 않음**

- 인증은 **에이전트 별**입니다. 새로운 에이전트는 메인 에이전트의 키를 상속받지 않습니다.
- 해당 에이전트에 대한 온보딩을 다시 수행하거나, 게이트웨이 호스트에서 설정 토큰 / API 키를 붙여넣고 `openclaw models status`로 확인하세요.

**프로파일 `anthropic:default`에 대한 자격 증명이 발견되지 않음**

- 어떤 인증 프로파일이 활성화되어 있는지 확인하려면 `openclaw models status`를 실행하세요.
- 온보딩을 다시 수행하거나, 해당 프로파일에 대한 설정 토큰 / API 키를 붙여넣으세요.

**사용 가능한 인증 프로파일이 없음 (모두 쿨다운/사용 불가 상태)**

- `openclaw models status --json`에서 `auth.unusableProfiles`을 확인하세요.
- 다른 Anthropic 프로파일을 추가하거나 쿨다운을 기다리세요.

추가 정보: [/gateway/troubleshooting](/ko-KR/gateway/troubleshooting) 및 [/help/faq](/ko-KR/help/faq).