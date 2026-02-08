---
summary: "OpenAI Chat Completions 호환 HTTP 엔드포인트"
read_when:
  - OpenClaw를 OpenAI 호환 API로 사용하고 싶을 때
  - 외부 도구에서 OpenClaw에 접속하고 싶을 때
title: "OpenAI 호환 HTTP API"
---

# OpenAI 호환 HTTP API

Gateway는 OpenAI Chat Completions API와 호환되는 HTTP 엔드포인트를 제공합니다. 기존 OpenAI SDK나 도구를 사용하여 OpenClaw 에이전트에 접속할 수 있습니다.

## 활성화

기본적으로 비활성화되어 있습니다. 설정에서 활성화하세요:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: {
          enabled: true,
        },
      },
    },
  },
}
```

## 엔드포인트

```
POST /v1/chat/completions
```

Gateway와 같은 포트 (기본: 18789)에서 제공됩니다.

## 인증

Bearer 토큰 인증:

```
Authorization: Bearer <gateway-token-or-password>
```

## 기본 사용법

### 비스트리밍 요청

```bash
curl http://127.0.0.1:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "openclaw:main",
    "messages": [
      {"role": "user", "content": "안녕하세요"}
    ]
  }'
```

### 스트리밍 요청

```bash
curl http://127.0.0.1:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "openclaw:main",
    "messages": [
      {"role": "user", "content": "파이썬 퀵소트 구현해줘"}
    ],
    "stream": true
  }'
```

스트리밍 응답은 Server-Sent Events (SSE) 형식입니다.

## 모델 선택

`model` 필드로 에이전트를 지정합니다:

```json
{
  "model": "openclaw:main"
}
```

또는 `x-openclaw-agent-id` 헤더 사용:

```
x-openclaw-agent-id: coding
```

에이전트 ID가 모델 이름 역할을 합니다.

## 세션 관리

기본적으로 **요청별 상태 비저장(stateless)** 입니다.

세션 유지를 위해 `user` 필드를 사용하세요:

```json
{
  "model": "openclaw:main",
  "user": "my-session-id",
  "messages": [
    {"role": "user", "content": "이전 대화를 기억하나요?"}
  ]
}
```

같은 `user` 값을 사용하면 같은 세션으로 라우팅됩니다.

## OpenAI SDK 사용

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:18789/v1",
    api_key="YOUR_GATEWAY_TOKEN",
)

response = client.chat.completions.create(
    model="openclaw:main",
    messages=[
        {"role": "user", "content": "안녕하세요"}
    ],
)
print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:18789/v1",
  apiKey: "YOUR_GATEWAY_TOKEN",
});

const response = await client.chat.completions.create({
  model: "openclaw:main",
  messages: [{ role: "user", content: "안녕하세요" }],
});
console.log(response.choices[0].message.content);
```

## OpenResponses API

OpenResponses 호환 엔드포인트도 제공합니다:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
        },
      },
    },
  },
}
```

```
POST /v1/responses
```

OpenResponses API는 아이템 기반 입력, 파일/이미지 첨부, 함수 도구 정의를 지원합니다.

## 도구 호출 API

에이전트 없이 직접 도구를 호출할 수 있습니다:

```
POST /tools/invoke
```

```bash
curl http://127.0.0.1:18789/tools/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "tool": "bash",
    "action": "run",
    "args": { "command": "ls -la" }
  }'
```

이 엔드포인트는 항상 활성화되어 있습니다.

## 원격 접속

로컬 네트워크 외부에서 접근하려면:

### SSH 터널

```bash
ssh -L 18789:127.0.0.1:18789 your-server
```

### Tailscale

[Tailscale 설정](/ko-KR/gateway/tailscale) 참조.

## 다음 단계

- [게이트웨이 프로토콜](/ko-KR/gateway/protocol) - WebSocket 프로토콜 상세
- [설정 가이드](/ko-KR/gateway/configuration) - 전체 설정 옵션
- [보안](/ko-KR/gateway/security) - 인증과 접근 제어
