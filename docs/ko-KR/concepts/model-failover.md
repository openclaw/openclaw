---
summary: "OpenClaw가 auth profiles를 회전하고 모델 간에 fallback하는 방법"
read_when:
  - Auth profile rotation, cooldowns, 또는 model failover 동작을 진단할 때
  - Auth profiles 또는 모델에 대한 failover 규칙을 업데이트할 때
title: "모델 Failover"
---

# 모델 Failover

OpenClaw는 두 단계에서 실패를 처리합니다:

1. **Auth profile rotation** within the current provider.
2. **모델 fallback** `agents.defaults.model.fallbacks`의 다음 모델로.

이 문서는 런타임 규칙 및 이를 뒷받침하는 데이터를 설명합니다.

## Auth storage (키 + OAuth)

OpenClaw는 API 키 및 OAuth tokens 모두에 **auth profiles**을 사용합니다.

- Secrets는 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`에 있습니다 (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Config `auth.profiles` / `auth.order`는 **metadata + routing only** (비밀 없음).
- Legacy import-only OAuth file: `~/.openclaw/credentials/oauth.json` (첫 사용에서 `auth-profiles.json`로 가져옴).

자세한 내용: [/concepts/oauth](/concepts/oauth)

자격증명 타입:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ 일부 providers에 대한 `projectId`/`enterpriseUrl`)

## 프로필 ID

OAuth 로그인은 distinct profiles를 생성하여 여러 계정이 공존할 수 있습니다.

- 기본값: email이 사용 가능하지 않을 때 `provider:default`.
- OAuth with email: `provider:<email>` (예: `google-antigravity:user@gmail.com`).

Profiles는 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`의 `profiles` 아래에 있습니다.

## 회전 순서

Provider가 여러 profiles를 가질 때, OpenClaw는 다음과 같은 순서를 선택합니다:

1. **Explicit config**: `auth.order[provider]` (설정된 경우).
2. **설정된 profiles**: provider로 필터링된 `auth.profiles`.
3. **저장된 profiles**: provider에 대한 `auth-profiles.json`의 항목.

명시적 순서가 설정되지 않은 경우, OpenClaw는 round‑robin 순서를 사용합니다:

- **Primary key:** profile type (**OAuth before API 키**).
- **Secondary key:** `usageStats.lastUsed` (oldest first, 각 타입 내).
- **Cooldown/disabled profiles**은 끝으로 이동하고, soonest expiry로 순서가 지정됩니다.

### 세션 stickiness (cache-friendly)

OpenClaw는 **선택된 auth profile을 per-session에서 pin**합니다 (provider 캐시를 따뜻하게 유지합니다).
모든 요청에서 회전하지 **않습니다**. Pinned profile은 다음과 같을 때까지 재사용됩니다:

- 세션이 reset될 때 (`/new` / `/reset`)
- compaction이 완료될 때 (compaction count increments)
- profile이 cooldown/disabled에 있을 때

Manual selection via `/model …@<profileId>`는 해당 세션에 대해 **user override**를 설정합니다
그리고 새 세션이 시작될 때까지 auto‑rotated되지 않습니다.

Auto‑pinned profiles (session router에 의해 선택됨)은 **preference**로 처리됩니다:
먼저 시도되지만, OpenClaw는 rate limits/timeouts에서 다른 profile로 회전할 수 있습니다.
User‑pinned profiles는 그 profile에 잠깁니다; 실패하고 model fallbacks이 설정된 경우,
OpenClaw는 profiles를 전환하는 대신 다음 모델로 이동합니다.

### OAuth가 "lost"로 보일 수 있는 이유

같은 provider에 대해 OAuth profile과 API key profile이 모두 있는 경우, round‑robin은 pinned되지 않은 한 메시지 간에 이들 간에 전환할 수 있습니다. 단일 profile을 강제하려면:

- `auth.order[provider] = ["provider:profileId"]`로 pin하거나,
- Per-session override를 사용하여 `/model …` (당신의 UI/chat surface가 지원하는 경우).

## Cooldowns

Profile이 auth/rate‑limit 오류 (또는 rate limiting처럼 보이는 timeout)로 실패할 때, OpenClaw는 이를 cooldown으로 표시하고 다음 profile로 이동합니다.
Format/invalid‑request 오류 (예: Cloud Code Assist tool call ID validation 실패)는 failover‑worthy로 처리되고 같은 cooldowns를 사용합니다.

Cooldowns는 exponential backoff를 사용합니다:

- 1분
- 5분
- 25분
- 1시간 (cap)

상태는 `auth-profiles.json`의 `usageStats` 아래에 저장됩니다:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## 청구 비활성화

청구/신용 실패 (예: "insufficient credits" / "credit balance too low")는 failover‑worthy로 처리되지만, 일반적으로 transient하지 않습니다. 짧은 cooldown 대신, OpenClaw는 profile을 **disabled** (더 긴 backoff 포함)로 표시합니다 그리고 다음 profile/provider로 회전합니다.

상태는 `auth-profiles.json`에 저장됩니다:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

기본값:

- 청구 backoff는 **5시간**에서 시작하고, 청구 실패마다 두 배씩 증가하며, **24시간**에서 cap됩니다.
- Backoff counters는 profile이 **24시간**에 실패하지 않으면 reset됩니다 (설정 가능).

## 모델 Fallback

모든 provider의 모든 profiles이 실패한 경우, OpenClaw는 `agents.defaults.model.fallbacks`의 다음 모델로 이동합니다. 이는 auth 실패, rate limits, 및 profile rotation을 소진한 timeouts에 적용됩니다 (다른 오류는 fallback을 발전시키지 않습니다).

Model override를 사용하여 실행이 시작될 때 (hooks 또는 CLI), fallbacks는 여전히 `agents.defaults.model.primary` 에서 설정된 configured fallbacks을 시도한 후 끝납니다.

## 관련 설정

전체 설정 참고서는 [게이트웨이 설정](/gateway/configuration)을 참조합니다:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

Broader 모델 선택 및 fallback 개요는 [모델](/concepts/models)을 참조합니다.
