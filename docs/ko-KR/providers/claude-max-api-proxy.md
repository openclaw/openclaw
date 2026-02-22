---
summary: "Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용"
read_when:
  - OpenAI 호환 도구와 함께 Claude Max 구독을 사용하고자 할 때
  - Claude Code CLI를 래핑한 로컬 API 서버가 필요할 때
  - API 키 대신 구독을 사용하여 비용을 절감하고자 할 때
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy**는 OpenAI 호환 API 엔드포인트로 Claude Max/Pro 구독을 노출하는 커뮤니티 도구입니다. 이 도구를 사용하면 OpenAI API 형식을 지원하는 모든 도구와 함께 구독을 사용할 수 있습니다.

## 왜 사용해야 할까요?

| 접근 방식                | 비용                                                | 적합한 용도                              |
| ----------------------- | --------------------------------------------------- | ---------------------------------------- |
| Anthropic API           | 토큰당 비용 지불 (~$15/M 입력, $75/M 출력 for Opus) | 생산 앱, 대량 사용                       |
| Claude Max 구독         | 월 $200 고정                                       | 개인 용도, 개발, 무제한 사용              |

Claude Max 구독이 있고 OpenAI 호환 도구와 함께 사용하려면, 이 프록시는 상당한 비용을 절감할 수 있습니다.

## 작동 방식

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

프록시는 다음과 같은 방식으로 작동합니다:

1. `http://localhost:3456/v1/chat/completions`에서 OpenAI 형식 요청을 수락합니다.
2. 이를 Claude Code CLI 명령어로 변환합니다.
3. OpenAI 형식으로 응답을 반환합니다 (스트리밍 지원).

## 설치

```bash
# Node.js 20+ 및 Claude Code CLI 필요
npm install -g claude-max-api-proxy

# Claude CLI가 인증되어 있는지 확인
claude --version
```

## 사용법

### 서버 시작

```bash
claude-max-api
# 서버는 http://localhost:3456 에서 실행됩니다
```

### 테스트

```bash
# 상태 확인
curl http://localhost:3456/health

# 모델 목록
curl http://localhost:3456/v1/models

# 채팅 완료
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw와 함께

OpenAI 호환 커스텀 엔드포인트로 프록시에 OpenClaw를 지정할 수 있습니다:

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

| 모델 ID             | 해당 모델         |
| ------------------- | ----------------- |
| `claude-opus-4`     | Claude Opus 4     |
| `claude-sonnet-4`   | Claude Sonnet 4   |
| `claude-haiku-4`    | Claude Haiku 4    |

## macOS에서 자동 시작

프록시를 자동으로 실행하기 위한 LaunchAgent를 생성합니다:

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

## 주의사항

- 이것은 **커뮤니티 도구**로, Anthropic 또는 OpenClaw에 의해 공식적으로 지원되지 않습니다.
- Claude Code CLI가 인증된 활성 Claude Max/Pro 구독이 필요합니다.
- 프록시는 로컬에서 실행되며 데이터를 제3자 서버로 전송하지 않습니다.
- 스트리밍 응답이 완벽하게 지원됩니다.

## 참고 자료

- [Anthropic provider](/ko-KR/providers/anthropic) - Claude setup-token 또는 API 키와 함께하는 Native OpenClaw 통합
- [OpenAI provider](/ko-KR/providers/openai) - OpenAI/Codex 구독을 위해