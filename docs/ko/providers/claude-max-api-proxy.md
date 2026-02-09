---
summary: "Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용합니다"
read_when:
  - OpenAI 호환 도구에서 Claude Max 구독을 사용하고 싶을 때
  - Claude Code CLI 를 감싸는 로컬 API 서버가 필요할 때
  - API 키 대신 구독을 사용해 비용을 절감하고 싶을 때
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** 는 Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 노출하는 커뮤니티 도구입니다. 이를 통해 OpenAI API 형식을 지원하는 어떤 도구와도 구독을 함께 사용할 수 있습니다.

## 왜 사용하나요?

| 접근 방식         | 비용                                                                       | 최적 대상             |
| ------------- | ------------------------------------------------------------------------ | ----------------- |
| Anthropic API | 토큰당 과금 (~$15/M 입력, $75/M 출력, Opus 기준) | 프로덕션 앱, 대량 사용     |
| Claude Max 구독 | 월 $200 정액                                                                | 개인 사용, 개발, 무제한 사용 |

Claude Max 구독이 있고 OpenAI 호환 도구와 함께 사용하고 싶다면, 이 프록시는 상당한 비용을 절감해 줄 수 있습니다.

## 작동 방식

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

이 프록시는 다음을 수행합니다:

1. `http://localhost:3456/v1/chat/completions` 에서 OpenAI 형식의 요청을 수신합니다
2. 이를 Claude Code CLI 명령으로 변환합니다
3. OpenAI 형식으로 응답을 반환합니다 (스트리밍 지원)

## 설치

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## 사용 방법

### 서버 시작

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### 테스트

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw 와 함께 사용하기

OpenClaw 를 사용자 지정 OpenAI 호환 엔드포인트로 프록시에 연결할 수 있습니다:

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## 사용 가능한 모델

| 모델 ID             | 매핑 대상           |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS 에서 자동 시작

프록시를 자동으로 실행하려면 LaunchAgent 를 생성합니다:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## 링크

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 참고 사항

- 이는 **커뮤니티 도구** 이며, Anthropic 또는 OpenClaw 에서 공식적으로 지원하지 않습니다
- Claude Code CLI 가 인증된 활성 Claude Max/Pro 구독이 필요합니다
- 프록시는 로컬에서 실행되며, 제3자 서버로 데이터를 전송하지 않습니다
- 스트리밍 응답이 완전히 지원됩니다

## 참고

- [Anthropic provider](/providers/anthropic) - setup-token 또는 API 키를 사용한 Claude 용 네이티브 OpenClaw 통합
- [OpenAI provider](/providers/openai) - OpenAI/Codex 구독용
