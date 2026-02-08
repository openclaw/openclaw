---
summary: "iMessage 및 Google Chat 채널 가이드"
read_when:
  - iMessage 설정 시
  - Google Chat 설정 시
title: "기타 채널"
---

# 기타 채널

## iMessage

상태: macOS에서 프로덕션 준비 완료.

### 요구사항

- macOS 필수
- Messages.app이 Apple ID로 로그인되어야 함
- BlueBubbles (선택적 대안)

### 네이티브 설정 (macOS)

```json5
{
  channels: {
    imessage: {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: ["+821012345678"],
    },
  },
}
```

### BlueBubbles 설정

BlueBubbles 서버가 필요합니다:

```json5
{
  channels: {
    bluebubbles: {
      enabled: true,
      serverUrl: "http://localhost:1234",
      password: "your_password",
    },
  },
}
```

### 제한사항

- macOS 전용 (네이티브)
- BlueBubbles는 macOS 서버 필요
- 그룹 메시지 기능 제한적

---

## Google Chat

상태: Google Workspace에서 프로덕션 준비 완료.

### 요구사항

- Google Workspace 계정
- Chat API 활성화
- 서비스 계정 또는 OAuth

### 설정 단계

1. Google Cloud Console에서 프로젝트 생성
2. Chat API 활성화
3. 서비스 계정 생성 및 키 다운로드

### 설정

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      credentials: "~/.openclaw/credentials/google-chat-sa.json",
      dmPolicy: "pairing",
    },
  },
}
```

### Webhook 모드

```json5
{
  channels: {
    googlechat: {
      mode: "webhook",
      webhookUrl: "https://chat.googleapis.com/...",
    },
  },
}
```

---

## Microsoft Teams

상태: Bot Framework로 프로덕션 준비 완료.

### 요구사항

- Azure 구독
- Bot Framework 등록
- Teams 앱 등록

### 설정

```json5
{
  channels: {
    teams: {
      enabled: true,
      appId: "your-app-id",
      appPassword: "your-app-password",
    },
  },
}
```

---

## Signal

상태: signald 기반으로 프로덕션 준비 완료.

### 요구사항

- signald 서버 실행 중
- 등록된 전화번호

### 설정

```json5
{
  channels: {
    signal: {
      enabled: true,
      signaldSocketPath: "/var/run/signald/signald.sock",
      phoneNumber: "+821012345678",
    },
  },
}
```

---

## Matrix

상태: 분산형 메시징 프로토콜 지원.

### 요구사항

- Matrix 계정 (예: matrix.org)
- 액세스 토큰

### 설정

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.org",
      userId: "@bot:matrix.org",
      accessToken: "your_access_token",
    },
  },
}
```

---

## Mattermost

상태: 오픈소스 Slack 대안 지원.

### 설정

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      serverUrl: "https://mattermost.example.com",
      token: "your_bot_token",
    },
  },
}
```

---

## LINE (베타)

상태: LINE Messaging API 베타 지원.

### 설정

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "your_token",
      channelSecret: "your_secret",
    },
  },
}
```

---

## 공통 설정

모든 채널에서 사용 가능한 공통 설정:

### DM 정책

```json5
{
  channels: {
    <channel>: {
      dmPolicy: "pairing",  // pairing | allowlist | open | disabled
      allowFrom: ["user_id"],
    },
  },
}
```

### 그룹 정책

```json5
{
  channels: {
    <channel>: {
      groupPolicy: "allowlist",  // open | allowlist | disabled
      groupAllowFrom: ["user_id"],
    },
  },
}
```

### 미디어 제한

```json5
{
  channels: {
    <channel>: {
      mediaMaxMb: 50,
    },
  },
}
```
