---
summary: "OpenClaw 보안 설정 가이드"
read_when:
  - 보안 설정을 검토할 때
  - DM 정책을 설정할 때
title: "보안"
---

# 보안 가이드

OpenClaw는 실제 메시징 플랫폼에 연결됩니다. 인바운드 DM을 **신뢰할 수 없는 입력**으로 취급하세요.

## DM 정책

기본적으로 알 수 없는 DM 발신자는 **페어링 코드**를 받습니다.

### 페어링 워크플로우

1. 알 수 없는 사용자가 봇에 DM을 보냅니다.
2. 봇이 페어링 코드를 반환합니다 (메시지는 처리되지 않음).
3. 관리자가 코드를 승인합니다:

```bash
openclaw pairing approve <channel> <code>
```

4. 사용자가 허용 목록에 추가됩니다.

### DM 정책 옵션

| 정책        | 설명                                   | 보안 수준     |
| ----------- | -------------------------------------- | ------------- |
| `pairing`   | 알 수 없는 발신자에게 페어링 코드 전송 | 높음 (기본값) |
| `allowlist` | 허용 목록에 있는 사용자만 접근         | 높음          |
| `open`      | 모든 DM 허용                           | **주의 필요** |
| `disabled`  | DM 비활성화                            | 최고          |

### 설정 예시

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+821012345678"],
    },
    telegram: {
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    },
  },
}
```

## 샌드박스 모드

비-주 세션(그룹/채널)을 Docker 샌드박스에서 실행합니다.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
      },
    },
  },
}
```

### 샌드박스 기본 설정

**허용 목록** (샌드박스 내에서 사용 가능):

- `bash`
- `process`
- `read`
- `write`
- `edit`
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

**거부 목록** (샌드박스에서 차단):

- `browser`
- `canvas`
- `nodes`
- `cron`
- `discord`
- `gateway`

## 그룹 보안

### 그룹 정책

```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist", // open | allowlist | disabled
      groupAllowFrom: ["user_id_1", "user_id_2"],
    },
  },
}
```

### 멘션 게이팅

기본적으로 그룹에서는 @멘션이 필요합니다:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

## 인증

### 비밀번호 인증

```json5
{
  gateway: {
    auth: {
      mode: "password",
      password: "your_secure_password",
    },
  },
}
```

### 토큰 인증

```json5
{
  gateway: {
    auth: {
      mode: "token",
      token: "your_secure_token",
    },
  },
}
```

## 원격 접근 보안

### Tailscale

Tailscale Serve/Funnel을 통한 안전한 원격 접근:

```json5
{
  gateway: {
    bind: "loopback", // 필수
    tailscale: {
      mode: "serve", // tailnet 전용
    },
  },
}
```

**Funnel (공개 접근) 사용 시 주의:**

- `gateway.auth.mode: "password"`가 필수입니다
- 강력한 비밀번호를 사용하세요

### 바인드 설정

| 설정       | 설명                       |
| ---------- | -------------------------- |
| `loopback` | 127.0.0.1만 (권장)         |
| `lan`      | 로컬 네트워크              |
| `any`      | 모든 인터페이스 (**주의**) |

```json5
{
  gateway: {
    bind: "loopback", // 가장 안전
  },
}
```

## 보안 점검

정기적으로 보안 설정을 점검하세요:

```bash
openclaw doctor
```

이 명령어는 다음을 확인합니다:

- 위험하거나 잘못 설정된 DM 정책
- 열린 그룹 설정
- 취약한 인증 설정

## 베스트 프랙티스

### 1. 최소 권한 원칙

- 필요한 사용자만 허용 목록에 추가
- 그룹에서는 멘션 게이팅 사용
- 사용하지 않는 채널 비활성화

### 2. 정기적인 검토

- 허용 목록 정기 검토
- 페어링 요청 모니터링
- 로그 검토

### 3. 환경 분리

- 프로덕션과 개발 환경 분리
- 테스트용 별도 봇 사용
- 중요한 자격 증명은 환경변수 사용

### 4. 토큰 관리

- 토큰이 노출되면 즉시 재생성
- 토큰을 코드에 하드코딩하지 않음
- `.env` 파일은 `.gitignore`에 추가

## 보안 관련 설정 요약

| 설정                           | 설명          | 권장값      |
| ------------------------------ | ------------- | ----------- |
| `gateway.bind`                 | 바인드 주소   | `loopback`  |
| `gateway.auth.mode`            | 인증 모드     | `password`  |
| `channels.*.dmPolicy`          | DM 정책       | `pairing`   |
| `channels.*.groupPolicy`       | 그룹 정책     | `allowlist` |
| `agents.defaults.sandbox.mode` | 샌드박스 모드 | `non-main`  |
