---
summary: "`secrets apply` 플랜의 계약: 대상 검증, 경로 매칭, `auth-profiles.json` 대상 범위"
read_when:
  - "`openclaw secrets apply` 플랜을 생성하거나 검토할 때"
  - "`Invalid plan target path` 오류를 디버깅할 때"
  - "대상 타입과 경로 검증 동작을 이해할 때"
title: "시크릿 적용 플랜 계약"
x-i18n:
  source_path: docs/gateway/secrets-plan-contract.md
---

# 시크릿 적용 플랜 계약

이 페이지는 `openclaw secrets apply`에 의해 강제되는 엄격한 계약을 정의합니다.

대상이 이러한 규칙과 일치하지 않으면, 설정을 변경하기 전에 적용이 실패합니다.

## 플랜 파일 형태

`openclaw secrets apply --from <plan.json>`은 플랜 대상의 `targets` 배열을 기대합니다:

```json5
{
  version: 1,
  protocolVersion: 1,
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
    {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:default.key",
      pathSegments: ["profiles", "openai:default", "key"],
      agentId: "main",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ],
}
```

## 지원되는 대상 범위

플랜 대상은 다음에서 지원되는 자격 증명 경로에 대해 허용됩니다:

- [SecretRef 자격 증명 표면](/reference/secretref-credential-surface)

## 대상 타입 동작

일반 규칙:

- `target.type`은 인식되어야 하며 정규화된 `target.path` 형태와 일치해야 합니다.

기존 플랜에 대해 호환성 별칭이 계속 허용됩니다:

- `models.providers.apiKey`
- `skills.entries.apiKey`
- `channels.googlechat.serviceAccount`

## 경로 검증 규칙

각 대상은 다음 모두로 검증됩니다:

- `type`은 인식된 대상 타입이어야 합니다.
- `path`는 비어 있지 않은 점 경로여야 합니다.
- `pathSegments`는 생략할 수 있습니다. 제공된 경우, `path`와 정확히 동일한 경로로 정규화되어야 합니다.
- 금지된 세그먼트가 거부됩니다: `__proto__`, `prototype`, `constructor`.
- 정규화된 경로는 대상 타입의 등록된 경로 형태와 일치해야 합니다.
- `providerId` 또는 `accountId`가 설정된 경우, 경로에 인코딩된 ID와 일치해야 합니다.
- `auth-profiles.json` 대상은 `agentId`가 필요합니다.
- 새 `auth-profiles.json` 매핑을 생성할 때 `authProfileProvider`를 포함합니다.

## 실패 동작

대상이 검증에 실패하면, 다음과 같은 오류와 함께 적용이 종료됩니다:

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

유효하지 않은 플랜에 대해서는 쓰기가 수행되지 않습니다.

## Exec 프로바이더 동의 동작

- `--dry-run`은 기본적으로 exec SecretRef 검사를 건너뜁니다.
- exec SecretRef/프로바이더를 포함하는 플랜은 `--allow-exec`가 설정되지 않으면 쓰기 모드에서 거부됩니다.
- exec를 포함하는 플랜을 검증/적용할 때, dry-run과 쓰기 명령 모두에서 `--allow-exec`를 전달합니다.

## 런타임 및 감사 범위 참고

- Ref 전용 `auth-profiles.json` 항목 (`keyRef`/`tokenRef`)은 런타임 해석 및 감사 범위에 포함됩니다.
- `secrets apply`는 지원되는 `openclaw.json` 대상, 지원되는 `auth-profiles.json` 대상, 선택적 정리 대상을 작성합니다.

## 운영자 확인

```bash
# 쓰기 없이 플랜 검증
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# 실제 적용
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json

# exec를 포함하는 플랜은 두 모드 모두에서 명시적으로 옵트인
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
```

유효하지 않은 대상 경로 메시지와 함께 적용이 실패하면, `openclaw secrets configure`로 플랜을 재생성하거나 위의 지원되는 형태로 대상 경로를 수정합니다.

## 관련 문서

- [시크릿 관리](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [SecretRef 자격 증명 표면](/reference/secretref-credential-surface)
- [설정 레퍼런스](/gateway/configuration-reference)
