---
summary: "API 엔드포인트 레퍼런스"
read_when:
  - API를 사용할 때
title: "API 레퍼런스"
---

# API 레퍼런스

OpenClaw Gateway HTTP API 엔드포인트 문서입니다.

## 인증

### Bearer 토큰

```bash
curl -H "Authorization: Bearer your_password" \
  http://localhost:18789/api/...
```

### 쿠키

브라우저에서 로그인 후 자동 포함

## 엔드포인트

### Health

```
GET /health
```

**응답:**

```json
{
  "status": "ok",
  "version": "2024.2.0",
  "uptime": 3600
}
```

---

### Chat

#### 메시지 전송

```
POST /api/chat
```

**요청:**

```json
{
  "message": "안녕하세요",
  "session": "custom-session-id",
  "agent": "main"
}
```

**응답:**

```json
{
  "response": "안녕하세요! 무엇을 도와드릴까요?",
  "sessionKey": "agent:main:api:dm:custom-session-id",
  "tokensUsed": 150
}
```

---

### Sessions

#### 세션 목록

```
GET /api/sessions
```

**응답:**

```json
{
  "sessions": [
    {
      "key": "agent:main:telegram:dm:123",
      "lastActive": "2024-02-08T12:00:00Z",
      "messageCount": 42
    }
  ]
}
```

#### 세션 히스토리

```
GET /api/sessions/:key/history
```

#### 세션 삭제

```
DELETE /api/sessions/:key
```

---

### Channels

#### 채널 상태

```
GET /api/channels
```

**응답:**

```json
{
  "channels": [
    {
      "id": "telegram",
      "status": "connected",
      "lastActivity": "2024-02-08T12:00:00Z"
    },
    {
      "id": "whatsapp",
      "status": "disconnected",
      "error": "Session expired"
    }
  ]
}
```

#### 채널 재연결

```
POST /api/channels/:id/reconnect
```

---

### Agents

#### 에이전트 목록

```
GET /api/agents
```

#### 에이전트 상태

```
GET /api/agents/:id/status
```

---

### Nodes

#### 노드 목록

```
GET /api/nodes
```

#### 페어링 코드

```
POST /api/nodes/pair
```

**응답:**

```json
{
  "code": "ABCD1234",
  "qrCode": "data:image/png;base64,...",
  "expiresAt": "2024-02-08T12:05:00Z"
}
```

---

### Config

#### 설정 조회

```
GET /api/config
```

#### 설정 업데이트

```
PATCH /api/config
```

**요청:**

```json
{
  "agents.defaults.model": "anthropic/claude-sonnet-4-20250514"
}
```

---

### Cron

#### 작업 목록

```
GET /api/cron
```

#### 작업 실행

```
POST /api/cron/:id/run
```

---

## 스트리밍

### SSE (Server-Sent Events)

```javascript
const eventSource = new EventSource("/api/chat/stream?session=...");

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.chunk);
};
```

## WebSocket

```javascript
const ws = new WebSocket("ws://localhost:18789/ws");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
};

ws.send(
  JSON.stringify({
    type: "chat",
    message: "안녕하세요",
  }),
);
```

## 오류 응답

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication required"
  }
}
```

### 오류 코드

| 코드            | HTTP | 설명           |
| --------------- | ---- | -------------- |
| `AUTH_REQUIRED` | 401  | 인증 필요      |
| `FORBIDDEN`     | 403  | 권한 없음      |
| `NOT_FOUND`     | 404  | 리소스 없음    |
| `RATE_LIMIT`    | 429  | 요청 제한 초과 |
| `INTERNAL`      | 500  | 내부 오류      |
