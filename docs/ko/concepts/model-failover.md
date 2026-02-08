---
read_when:
    - 인증 프로필 교체, 휴지 또는 모델 대체 동작 진단
    - 인증 프로필 또는 모델에 대한 장애 조치 규칙 업데이트
summary: OpenClaw가 인증 프로필을 회전하고 모델 전체에 걸쳐 폴백하는 방법
title: 모델 장애 조치
x-i18n:
    generated_at: "2026-02-08T15:52:47Z"
    model: gtx
    provider: google-translate
    source_hash: eab7c0633824d941cf0d6ce4294f0bc8747fbba2ce93650e9643eca327cd04a9
    source_path: concepts/model-failover.md
    workflow: 15
---

# 모델 장애 조치

OpenClaw는 두 단계로 오류를 처리합니다.

1. **인증 프로필 순환** 현재 공급자 내에서.
2. **모델 대체** 다음 모델로 `agents.defaults.model.fallbacks`.

이 문서에서는 런타임 규칙과 이를 뒷받침하는 데이터에 대해 설명합니다.

## 인증 저장소(키 + OAuth)

OpenClaw는 다음을 사용합니다. **인증 프로필** API 키와 OAuth 토큰 모두에 대해.

- 비밀이 살아있다 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (유산: `~/.openclaw/agent/auth-profiles.json`).
- 구성 `auth.profiles` / `auth.order` ~이다 **메타데이터 + 라우팅만** (비밀은 없습니다).
- 기존 가져오기 전용 OAuth 파일: `~/.openclaw/credentials/oauth.json` (다음으로 가져옴 `auth-profiles.json` 처음 사용시).

더 자세한 내용: [/개념/oauth](/concepts/oauth)

자격 증명 유형:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId` / `enterpriseUrl` 일부 제공업체의 경우)

## 프로필 ID

OAuth 로그인은 여러 계정이 공존할 수 있도록 고유한 프로필을 생성합니다.

- 기본: `provider:default` 이메일을 사용할 수 없을 때.
- 이메일로 OAuth: `provider:<email>` (예를 들어 `google-antigravity:user@gmail.com`).

프로필은 다음 위치에 있습니다. `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 아래에 `profiles`.

## 회전 순서

공급자에 여러 프로필이 있는 경우 OpenClaw는 다음과 같은 순서를 선택합니다.

1. **명시적 구성**: `auth.order[provider]` (설정된 경우).
2. **구성된 프로필**: `auth.profiles` 공급자로 필터링됩니다.
3. **저장된 프로필**: 항목 `auth-profiles.json` 공급자를 위해.

명시적인 순서가 구성되지 않은 경우 OpenClaw는 라운드 로빈 순서를 사용합니다.

- **기본 키:** 프로필 유형(**API 키 이전의 OAuth**).
- **보조 키:** `usageStats.lastUsed` (각 유형 내에서 가장 오래된 것부터).
- **쿨다운/비활성화된 프로필** 가장 빠른 만료 순으로 순서대로 끝으로 이동됩니다.

### 세션 고정성(캐시 친화적)

오픈클로 **세션당 선택한 인증 프로필을 고정합니다.** 공급자 캐시를 따뜻하게 유지합니다.
그렇습니다 **~ 아니다** 모든 요청에 ​​대해 회전합니다. 고정된 프로필은 다음 때까지 재사용됩니다.

- 세션이 재설정됩니다(`/new` / `/reset`)
- 압축 완료(압축 횟수 증가)
- 프로필이 대기 중이거나 비활성화되었습니다.

수동 선택을 통해 `/model …@<profileId>` 세트하다 **사용자 재정의** 해당 세션에 대해
새 세션이 시작될 때까지 자동 순환되지 않습니다.

자동 고정 프로필(세션 라우터에 의해 선택됨)은 **선호**:
먼저 시도되지만 OpenClaw는 속도 제한/시간 초과로 인해 다른 프로필로 회전할 수 있습니다.
사용자가 고정한 프로필은 해당 프로필에 고정된 상태로 유지됩니다. 실패하고 모델이 대체되는 경우
구성되면 OpenClaw는 프로필을 전환하는 대신 다음 모델로 이동합니다.

### OAuth가 "잃어버린 것처럼 보일" 수 있는 이유

동일한 공급자에 대한 OAuth 프로필과 API 키 프로필이 모두 있는 경우 고정되지 않는 한 라운드 로빈은 메시지 간에 전환할 수 있습니다. 단일 프로필을 강제로 적용하려면:

- 다음으로 고정 `auth.order[provider] = ["provider:profileId"]`, 또는
- 다음을 통해 세션별 재정의를 사용하세요. `/model …` 프로필 재정의(UI/채팅 화면에서 지원되는 경우)

## 쿨다운

인증/비율 제한 오류(또는 다음과 같은 시간 초과로 인해 프로필이 실패하는 경우)
속도 제한과 마찬가지로 OpenClaw는 이를 쿨다운으로 표시하고 다음 프로필로 이동합니다.
형식/잘못된 요청 오류(예: Cloud Code Assist 도구 호출 ID)
검증 실패)은 장애 조치 가능한 것으로 간주되며 동일한 휴지 시간을 사용합니다.

휴지 시간은 지수 백오프를 사용합니다.

- 1분
- 5분
- 25분
- 1시간(상한)

상태는 다음 위치에 저장됩니다. `auth-profiles.json` 아래에 `usageStats`: 

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

## 결제가 비활성화됩니다.

청구/크레딧 실패(예: "크레딧 부족"/ "크레딧 잔액 너무 낮음")는 장애 조치가 가능한 것으로 간주되지만 일반적으로 일시적이지 않습니다. 짧은 쿨다운 대신 OpenClaw는 프로필을 다음과 같이 표시합니다. **장애가 있는** (백오프 시간이 길어짐) 다음 프로필/공급자로 순환됩니다.

상태는 다음 위치에 저장됩니다. `auth-profiles.json`: 

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

- 결제 백오프 시작 시간: **5시간**, 청구 실패당 두 배, 한도는 다음과 같습니다. **24시간**.
- 프로필이 실패하지 않은 경우 백오프 카운터가 재설정됩니다. **24시간** (구성 가능).

## 모델 대체

공급자의 모든 프로필이 실패하면 OpenClaw는 다음 모델로 이동합니다.
`agents.defaults.model.fallbacks`. 이는 인증 실패, 비율 제한 등에 적용됩니다.
프로필 회전을 소진한 시간 초과(다른 오류로 인해 대체가 진행되지 않음)

모델 재정의(후크 또는 CLI)로 실행이 시작되면 폴백은 계속해서 종료됩니다.
`agents.defaults.model.primary` 구성된 폴백을 시도한 후.

## 관련 구성

보다 [게이트웨이 구성](/gateway/configuration) 을 위한:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 라우팅

보다 [모델](/concepts/models) 더 폭넓은 모델 선택 및 대체 개요를 확인하세요.
