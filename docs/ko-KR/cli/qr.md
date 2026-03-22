---
summary: "`openclaw qr` CLI 레퍼런스 (iOS 페어링 QR + 설정 코드 생성)"
read_when:
  - iOS 앱을 Gateway에 빠르게 페어링하고 싶을 때
  - 원격/수동 공유를 위한 설정 코드 출력이 필요할 때
title: "qr"
x-i18n:
  source_path: "docs/cli/qr.md"
---

# `openclaw qr`

현재 Gateway 설정에서 iOS 페어링 QR과 설정 코드를 생성합니다.

## 사용법

```bash
openclaw qr
openclaw qr --setup-code-only
openclaw qr --json
openclaw qr --remote
openclaw qr --url wss://gateway.example/ws
```

## 옵션

- `--remote`: 설정에서 `gateway.remote.url`과 원격 토큰/비밀번호를 사용
- `--url <url>`: 페이로드에 사용되는 Gateway URL 재정의
- `--public-url <url>`: 페이로드에 사용되는 공개 URL 재정의
- `--token <token>`: 부트스트랩 흐름이 인증하는 Gateway 토큰 재정의
- `--password <password>`: 부트스트랩 흐름이 인증하는 Gateway 비밀번호 재정의
- `--setup-code-only`: 설정 코드만 출력
- `--no-ascii`: ASCII QR 렌더링 건너뛰기
- `--json`: JSON 출력 (`setupCode`, `gatewayUrl`, `auth`, `urlSource`)

## 참고

- `--token`과 `--password`는 상호 배타적입니다.
- 설정 코드 자체는 이제 공유 Gateway 토큰/비밀번호가 아닌 단기 유효한 불투명 `bootstrapToken`을 포함합니다.
- `--remote` 사용 시, 실질적으로 활성화된 원격 자격 증명이 SecretRef로 설정되어 있고 `--token`이나 `--password`를 전달하지 않으면, 명령은 활성 Gateway 스냅샷에서 해석합니다. Gateway를 사용할 수 없으면 명령이 즉시 실패합니다.
- `--remote` 없이, CLI 인증 재정의가 전달되지 않으면 로컬 Gateway 인증 SecretRef가 해석됩니다:
  - `gateway.auth.token`은 토큰 인증이 우선할 수 있을 때 해석됩니다 (명시적 `gateway.auth.mode="token"` 또는 비밀번호 소스가 우선하지 않는 추론 모드).
  - `gateway.auth.password`는 비밀번호 인증이 우선할 수 있을 때 해석됩니다 (명시적 `gateway.auth.mode="password"` 또는 auth/env에서 우선하는 토큰이 없는 추론 모드).
- `gateway.auth.token`과 `gateway.auth.password`가 모두 설정되어 있고 (SecretRef 포함) `gateway.auth.mode`가 설정되지 않은 경우, mode가 명시적으로 설정될 때까지 설정 코드 해석이 실패합니다.
- Gateway 버전 호환성 참고: 이 명령 경로는 `secrets.resolve`를 지원하는 Gateway가 필요합니다. 이전 버전의 Gateway는 알 수 없는 메서드 오류를 반환합니다.
- 스캔 후 다음 명령으로 디바이스 페어링을 승인하세요:
  - `openclaw devices list`
  - `openclaw devices approve <requestId>`
