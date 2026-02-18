---
summary: "OpenClaw가 인증 프로필을 회전시키고 모델에 걸쳐 백업되는 방법"
read_when:
  - 인증 프로필 회전, 쿨다운 또는 모델 백업 동작 진단
  - 인증 프로필 또는 모델에 대한 페일오버 규칙 업데이트
title: "모델 페일오버"
---

# 모델 페일오버

OpenClaw는 두 단계로 실패를 처리합니다:

1. 현재 프로바이더 내에서 **인증 프로필 회전**.
2. `agents.defaults.model.fallbacks`의 다음 모델로 **모델 백업**.

이 문서는 실행 시의 규칙과 이를 뒷받침하는 데이터를 설명합니다.

## 인증 저장소 (키 + OAuth)

OpenClaw는 API 키와 OAuth 토큰 모두에 **인증 프로필**을 사용합니다.

- 비밀정보는 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`에 저장됩니다 (이전 버전: `~/.openclaw/agent/auth-profiles.json`).
- 설정 `auth.profiles` / `auth.order`는 **메타데이터 + 라우팅 전용**입니다 (비밀정보 없음).
- 이전에 가져오기 전용 OAuth 파일: `~/.openclaw/credentials/oauth.json` (첫 사용 시 `auth-profiles.json`으로 가져옵니다).

자세한 내용: [/concepts/oauth](/concepts/oauth)

자격증명 유형:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ 일부 프로바이더의 경우 `projectId`/`enterpriseUrl`)

## 프로필 ID

OAuth 로그인은 여러 계정이 공존할 수 있도록 별개의 프로필을 만듭니다.

- 기본: 이메일이 없는 경우 `provider:default`.
- 이메일이 포함된 OAuth: `provider:<email>` (예: `google-antigravity:user@gmail.com`).

프로필은 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`의 `profiles` 아래에 저장됩니다.

## 회전 순서

프로바이더에 여러 프로필이 있는 경우, OpenClaw는 다음과 같은 순서를 선택합니다:

1. **명시적 설정**: `auth.order[provider]` (설정된 경우).
2. **설정된 프로필**: 프로바이더에 의해 필터링된 `auth.profiles`.
3. **저장된 프로필**: 프로바이더에 대한 `auth-profiles.json`의 항목.

명시적 순서가 설정되지 않은 경우, OpenClaw는 라운드 로빈 순서를 사용합니다:

- **주 키:** 프로필 유형 (**OAuth가 API 키보다 우선**).
- **보조 키:** `usageStats.lastUsed` (각 유형 내에서 가장 오래된 것부터).
- **쿨다운/비활성화된 프로필**은 끝으로 이동하며, 가장 빠른 만료순으로 정렬됩니다.

### 세션 붙박음 (캐시 친화적)

OpenClaw는 **선택된 인증 프로필을 세션마다 고정**하여 프로바이더 캐시를 따뜻하게 유지합니다.
모든 요청에서 회전하지 않습니다. 고정된 프로필은 다음과 같은 경우에 다시 사용됩니다:

- 세션이 재설정될 때 (`/new` / `/reset`)
- 압축 이 완료될 때 (압축 횟수가 증가합니다)
- 프로필이 쿨다운/비활성 상태인 경우

`/model …@<profileId>`를 통한 수동 선택은 해당 세션에서 **사용자 재정의**를 설정하며
새 세션이 시작되기 전까지는 자동으로 회전하지 않습니다.

자동으로 고정된 프로필 (세션 라우터에 의해 선택됨)은 **선호사항**으로 처리됩니다:
먼저 시도되지만, OpenClaw는 비율 제한/타임아웃 시 다른 프로필로 회전할 수 있습니다.
사용자 고정 프로필은 그 프로필에 잠겨 있습니다; 실패하고 모델 페일오버가 설정된 경우, OpenClaw는 프로필을 전환하는 대신 다음 모델로 이동합니다.

### 왜 OAuth가 "잃어버린 것처럼 보일 수 있는가"

같은 프로바이더에 대해 OAuth 프로필과 API 키 프로필 모두를 가지고 있는 경우, 고정되지 않으면 라운드 로빈이 메시지 간에 전환할 수 있습니다. 단일 프로필을 강제하려면:

- `auth.order[provider] = ["provider:profileId"]`로 고정하거나,
- 프로필 재정의와 함께 `/model …`을 통해 세션당 재정의를 사용하세요 (사용하는 UI/채팅 인터페이스에서 지원되는 경우).

## 쿨다운

인증/비율 제한 오류 (또는 비율 제한처럼 보이는 타임아웃)로 인해 프로필이 실패할 때, OpenClaw는 이를 쿨다운 상태로 표시하고 다음 프로필로 이동합니다.
형식/유효하지 않은 요청 오류 (예: Cloud Code Assist 도구 호출 ID 검증 실패)는 페일오버 가능하다고 간주되며 동일한 쿨다운을 사용합니다.

쿨다운은 지수 백오프를 사용합니다:

- 1분
- 5분
- 25분
- 1시간 (캡)

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

청구/크레딧 실패 (예: "크레딧이 부족합니다" / "크레딧 잔액이 너무 낮습니다")는 페일오버 가능하다고 간주되지만, 일반적으로 일시적이지 않습니다. 짧은 쿨다운 대신, OpenClaw는 프로파일을 **비활성화**로 표시하고 (더 긴 백오프를 사용하여) 다음 프로필/프로바이더로 회전합니다.

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

- 청구 백오프는 **5시간**에서 시작하며, 청구 실패 시마다 두 배가 되고, **24시간**에서 한도가 있습니다.
- 백오프 카운터는 프로필이 **24시간** 동안 실패하지 않으면 리셋됩니다 (구성 가능).

## 모델 페일오버

프로바이더의 모든 프로필이 실패하면, OpenClaw는 `agents.defaults.model.fallbacks`의 다음 모델로 이동합니다. 이는 인증 실패, 비율 제한 및 프로필 회전이 다 소모된 타임아웃에 적용됩니다 (다른 오류는 페일오버를 진행하지 않습니다).

런이 모델 재정의로 시작되면 (훅 또는 CLI), 구성된 페일오버를 시도한 후에도 여전히 `agents.defaults.model.primary`에서 종료됩니다.

## 관련 구성

[게이트웨이 구성](/gateway/configuration)을 참조하세요:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 라우팅

더 넓은 모델 선택 및 페일오버 개요는 [모델](/concepts/models)을 참조하세요.
