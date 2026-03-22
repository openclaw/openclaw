---
title: "인증 자격 증명 의미론"
summary: "인증 프로필의 정식 자격 증명 적격성 및 해석 의미론"
read_when:
  - 인증 프로필 해석 또는 자격 증명 라우팅 작업 시
  - 모델 인증 실패 또는 프로필 순서를 디버깅할 때
x-i18n:
  source_path: docs/auth-credential-semantics.md
---

# 인증 자격 증명 의미론

이 문서는 다음에서 사용되는 정식 자격 증명 적격성 및 해석 의미론을 정의합니다:

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

목표는 선택 시점과 런타임 동작을 일관되게 유지하는 것입니다.

## 안정적 이유 코드

- `ok`
- `missing_credential`
- `invalid_expires`
- `expired`
- `unresolved_ref`

## 토큰 자격 증명

토큰 자격 증명 (`type: "token"`)은 인라인 `token` 및/또는 `tokenRef`를 지원합니다.

### 적격성 규칙

1. `token`과 `tokenRef` 모두 없으면 토큰 프로필은 부적격합니다.
2. `expires`는 선택 사항입니다.
3. `expires`가 있는 경우, `0`보다 큰 유한 숫자여야 합니다.
4. `expires`가 유효하지 않으면 (`NaN`, `0`, 음수, 비유한, 또는 잘못된 타입), 프로필은 `invalid_expires`로 부적격합니다.
5. `expires`가 과거이면, 프로필은 `expired`로 부적격합니다.
6. `tokenRef`는 `expires` 검증을 우회하지 않습니다.

### 해석 규칙

1. 해석 의미론은 `expires`에 대한 적격성 의미론과 일치합니다.
2. 적격한 프로필의 경우, 토큰 재료는 인라인 값 또는 `tokenRef`에서 해석될 수 있습니다.
3. 해석할 수 없는 참조는 `models status --probe` 출력에서 `unresolved_ref`를 생성합니다.

## 레거시 호환 메시지

스크립트 호환성을 위해, 프로브 오류는 이 첫 줄을 변경하지 않습니다:

`Auth profile credentials are missing or expired.`

사람이 읽을 수 있는 세부 정보와 안정적 이유 코드는 후속 줄에 추가될 수 있습니다.
