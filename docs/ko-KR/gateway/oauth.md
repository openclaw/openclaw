---
summary: "OAuth 인증 설정"
read_when:
  - OAuth를 설정할 때
title: "OAuth"
---

# OAuth 인증

OAuth를 사용한 인증 설정 가이드입니다.

## 지원 Provider

| Provider  | 설명                  |
| --------- | --------------------- |
| Google    | Google 계정 인증      |
| GitHub    | GitHub 계정 인증      |
| Microsoft | Microsoft 계정 인증   |
| Tailscale | Tailscale 사용자 인증 |

## Google OAuth

### 1. Google Cloud 설정

1. [Google Cloud Console](https://console.cloud.google.com) 접속
2. OAuth 동의 화면 설정
3. OAuth 클라이언트 ID 생성

### 2. OpenClaw 설정

```json5
{
  gateway: {
    auth: {
      mode: "oauth",
      oauth: {
        provider: "google",
        clientId: "your-client-id.apps.googleusercontent.com",
        clientSecret: "your-client-secret",
        allowedEmails: ["you@gmail.com"],
      },
    },
  },
}
```

## GitHub OAuth

### 1. GitHub App 생성

1. GitHub Settings → Developer settings → OAuth Apps
2. New OAuth App 생성
3. Callback URL: `http://localhost:18789/auth/callback`

### 2. 설정

```json5
{
  gateway: {
    auth: {
      mode: "oauth",
      oauth: {
        provider: "github",
        clientId: "your-client-id",
        clientSecret: "your-client-secret",
        allowedUsers: ["your-username"],
      },
    },
  },
}
```

## Microsoft OAuth

```json5
{
  gateway: {
    auth: {
      mode: "oauth",
      oauth: {
        provider: "microsoft",
        clientId: "your-client-id",
        clientSecret: "your-client-secret",
        tenant: "common", // 또는 특정 테넌트 ID
        allowedEmails: ["you@outlook.com"],
      },
    },
  },
}
```

## Tailscale 인증

Tailscale을 사용하면 별도 OAuth 설정 없이 인증 가능:

```json5
{
  gateway: {
    auth: {
      mode: "tailscale",
    },
    tailscale: {
      mode: "serve",
    },
  },
}
```

## 허용 목록

### 이메일 기반

```json5
{
  gateway: {
    auth: {
      oauth: {
        allowedEmails: [
          "user1@gmail.com",
          "user2@company.com",
          "*@trusted-domain.com", // 도메인 전체
        ],
      },
    },
  },
}
```

### 사용자명 기반

```json5
{
  gateway: {
    auth: {
      oauth: {
        allowedUsers: ["username1", "username2"],
      },
    },
  },
}
```

## 세션 관리

### 세션 만료

```json5
{
  gateway: {
    auth: {
      session: {
        maxAge: 86400, // 초 (24시간)
        refreshToken: true,
      },
    },
  },
}
```

### 동시 세션

```json5
{
  gateway: {
    auth: {
      session: {
        maxConcurrent: 3,
      },
    },
  },
}
```

## 문제 해결

### 콜백 URL 오류

- 올바른 콜백 URL 등록 확인:
  - 로컬: `http://localhost:18789/auth/callback`
  - Tailscale: `https://hostname.ts.net/auth/callback`

### 인증 실패

1. 클라이언트 ID/Secret 확인
2. 허용 목록 확인
3. Provider 설정 확인

### 토큰 만료

- 자동 갱신 활성화
- 재로그인 필요 시 세션 삭제
