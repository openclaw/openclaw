---
summary: "외부 서비스에서 OpenClaw 트리거"
read_when:
  - 웹훅을 설정할 때
title: "웹훅"
---

# 웹훅

외부 서비스에서 OpenClaw를 트리거하는 HTTP 엔드포인트입니다.

## 기본 설정

```json5
{
  webhook: {
    enabled: true,
    secret: "your_webhook_secret",
    path: "/webhook",
  },
}
```

## 웹훅 호출

### 기본 요청

```bash
curl -X POST http://127.0.0.1:18789/webhook \
  -H "Authorization: Bearer your_webhook_secret" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "이 데이터를 분석해줘",
    "context": {
      "source": "external-app"
    }
  }'
```

### 응답

```json
{
  "success": true,
  "sessionId": "webhook:abc123",
  "response": "분석 결과..."
}
```

## 요청 형식

### 필수 필드

```json
{
  "prompt": "에이전트에게 보낼 메시지"
}
```

### 선택 필드

```json
{
  "prompt": "메시지",
  "agent": "main",
  "context": {
    "source": "github",
    "event": "push",
    "data": {}
  },
  "target": {
    "channel": "telegram",
    "to": "123456789"
  },
  "session": "custom-session-id"
}
```

## 라우팅

### 소스별 라우팅

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "github" },
        agent: "devops",
        target: {
          channel: "slack",
          to: "C12345678",
        },
      },
      {
        match: { source: "monitoring" },
        agent: "monitor",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

### 이벤트별 라우팅

```json5
{
  webhook: {
    routes: [
      {
        match: {
          source: "github",
          event: "push",
        },
        prompt: "새 커밋이 푸시되었습니다: {{data}}",
        agent: "coder",
      },
      {
        match: {
          source: "github",
          event: "issue",
        },
        prompt: "새 이슈가 생성되었습니다: {{data}}",
        target: {
          channel: "discord",
          to: "channel_id",
        },
      },
    ],
  },
}
```

## 인증

### Bearer 토큰

```bash
curl -H "Authorization: Bearer your_secret" ...
```

### 헤더 기반

```json5
{
  webhook: {
    auth: {
      type: "header",
      header: "X-Webhook-Secret",
      value: "your_secret",
    },
  },
}
```

### HMAC 서명

```json5
{
  webhook: {
    auth: {
      type: "hmac",
      header: "X-Hub-Signature-256",
      secret: "your_secret",
    },
  },
}
```

## 실용적인 예시

### GitHub 웹훅

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "github" },
        transform: {
          prompt: "GitHub 이벤트: {{event}}\n{{data.commits}}",
        },
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

### 모니터링 알림

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "uptime-robot" },
        prompt: "서버 상태 변경: {{data.monitor}} - {{data.status}}",
        agent: "monitor",
        target: {
          channel: "slack",
          to: "#alerts",
        },
      },
    ],
  },
}
```

### 폼 제출

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "contact-form" },
        prompt: "새 문의: {{data.name}} - {{data.message}}",
        target: {
          channel: "telegram",
          to: "123456789",
        },
      },
    ],
  },
}
```

## 응답 처리

### 동기 응답

```json5
{
  webhook: {
    responseMode: "sync",
    timeout: 30, // 초
  },
}
```

### 비동기 (즉시 반환)

```json5
{
  webhook: {
    responseMode: "async",
    callbackUrl: "https://your-app.com/callback",
  },
}
```

## 변환 (Transform)

### 프롬프트 템플릿

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "any" },
        transform: {
          prompt: `
            소스: {{source}}
            이벤트: {{event}}
            데이터: {{json data}}
          `,
        },
      },
    ],
  },
}
```

### 데이터 추출

```json5
{
  webhook: {
    routes: [
      {
        match: { source: "github" },
        transform: {
          extract: {
            commits: "data.commits",
            author: "data.pusher.name",
          },
        },
      },
    ],
  },
}
```

## 로깅

```json5
{
  webhook: {
    logging: {
      requests: true,
      responses: true,
      redact: ["secret", "token"],
    },
  },
}
```

## 문제 해결

### 401 Unauthorized

- secret이 올바른지 확인
- Authorization 헤더 형식 확인

### 404 Not Found

- 웹훅 경로 확인 (`/webhook`)
- Gateway가 실행 중인지 확인

### 타임아웃

- 타임아웃 값 증가
- 비동기 모드 사용 고려
