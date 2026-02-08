---
summary: "Tailscale을 통한 안전한 원격 접근"
read_when:
  - 원격에서 Gateway에 접근하고 싶을 때
title: "Tailscale"
---

# Tailscale 연동

Tailscale을 사용하면 VPN이나 포트 포워딩 없이 안전하게 원격 접근할 수 있습니다.

## Tailscale이란?

Tailscale은 WireGuard 기반의 제로 구성 VPN입니다:

- 설정이 간단함
- NAT 뒤에서도 작동
- 엔드투엔드 암호화

## 모드

### Serve 모드

tailnet 내에서만 접근 가능 (권장):

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: {
      mode: "serve",
    },
  },
}
```

### Funnel 모드

공개 인터넷에서 접근 가능:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: {
      mode: "funnel",
    },
    auth: {
      mode: "password",
      password: "strong_password", // 필수!
    },
  },
}
```

> ⚠️ **경고**: Funnel 사용 시 반드시 강력한 비밀번호 설정

## 설정 단계

### 1. Tailscale 설치

**macOS:**

```bash
brew install tailscale
```

**Linux:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

**Windows:**
[Tailscale 다운로드](https://tailscale.com/download)

### 2. Tailscale 로그인

```bash
sudo tailscale up
```

### 3. OpenClaw 설정

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: {
      mode: "serve",
    },
  },
}
```

### 4. Gateway 시작

```bash
openclaw gateway
```

## Tailscale Serve

tailnet 내 기기에서만 접근:

```
https://<hostname>.<tailnet-name>.ts.net
```

### 장점

- 외부에서 접근 불가
- 추가 인증 불필요 (선택사항)
- Tailscale MagicDNS 사용

## Tailscale Funnel

공개 URL로 접근:

```
https://<hostname>.<tailnet-name>.ts.net
```

### 요구사항

- Tailscale 계정에서 Funnel 활성화
- 강력한 비밀번호 설정

### 활성화

Tailscale 관리 콘솔에서:

1. DNS 설정으로 이동
2. Funnel 활성화

## 보안 설정

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

### Tailscale 사용자 인증 (Serve 모드)

```json5
{
  gateway: {
    auth: {
      mode: "tailscale", // Tailscale 사용자 자동 인증
    },
  },
}
```

### 혼합 인증

```json5
{
  gateway: {
    auth: {
      mode: "password",
      allowTailscale: true, // tailnet 사용자는 비밀번호 불필요
    },
  },
}
```

## 문제 해결

### Tailscale이 연결되지 않음

```bash
# 상태 확인
tailscale status

# 다시 로그인
sudo tailscale up --reset
```

### Serve가 작동하지 않음

```bash
# Tailscale serve 상태 확인
tailscale serve status

# 수동으로 serve 시작
tailscale serve --bg 18789
```

### Funnel이 작동하지 않음

1. Tailscale 관리 콘솔에서 Funnel 활성화 확인
2. DNS가 올바르게 설정되었는지 확인
3. HTTPS 인증서 발급 대기 (최대 몇 분)

## 다른 기기에서 접근

### iOS/Android

1. Tailscale 앱 설치
2. 같은 계정으로 로그인
3. 브라우저에서 `https://<hostname>.ts.net` 접속

### 다른 컴퓨터

1. Tailscale 설치 및 로그인
2. 브라우저에서 접속

## 베스트 프랙티스

1. **Serve 우선**: 가능하면 Serve 모드 사용
2. **강력한 비밀번호**: Funnel 사용 시 필수
3. **MagicDNS 활용**: IP 대신 호스트명 사용
4. **Access Control**: Tailscale ACL로 추가 제한
