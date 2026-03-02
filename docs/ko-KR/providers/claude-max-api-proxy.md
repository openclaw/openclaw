---
summary: "Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용합니다"
read_when:
  - OpenAI 호환 도구와 함께 Claude Max 구독을 사용하고 싶을 때
  - Claude Code CLI를 래핑하는 로컬 API 서버를 원할 때
  - API 키 대신 구독을 사용하여 비용을 절약하고 싶을 때
title: "Claude Max API 프록시"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/providers/claude-max-api-proxy.md"
  workflow: 15
---

# Claude Max API 프록시

**claude-max-api-proxy**는 Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 노출하는 커뮤니티 도구입니다. 이를 통해 OpenAI API 형식을 지원하는 모든 도구와 함께 구독을 사용할 수 있습니다.

## 왜 이것을 사용합니까?

| 접근 방식       | 비용                                              | 최고:                        |
| --------------- | ------------------------------------------------- | ---------------------------- |
| Anthropic API   | 토큰당 지불 (~Opus의 경우 M 입력 $15, M 출력 $75) | 프로덕션 앱, 대용량          |
| Claude Max 구독 | 월 $200 정액                                      | 개인 사용, 개발, 무제한 사용 |

Claude Max 구독이 있고 OpenAI 호환 도구와 함께 사용하고 싶다면 이 프록시가 상당한 비용을 절약할 수 있습니다.

## 작동 방식

```
사용자 앱 → claude-max-api-proxy → Claude Code CLI → Anthropic (구독을 통해)
     (OpenAI 형식)              (형식 변환)      (로그인 사용)
```

프록시:

1. `http://localhost:3456/v1/chat/completions`에서 OpenAI 형식 요청을 수락합니다
2. 이를 Claude Code CLI 명령으로 변환합니다
3. OpenAI 형식의 응답을 반환합니다 (스트리밍 지원)

## 설치

```bash
# Node.js 20 이상 및 Claude Code CLI 필요
npm install -g claude-max-api-proxy

# Claude CLI가 인증되었는지 확인
claude --version
```

## 사용

### 서버 시작

```bash
claude-max-api
# 서버는 http://localhost:3456에서 실행됩니다
```

### 테스트

```bash
# 상태 확인
curl http://localhost:3456/health

# 모델 나열
curl http://localhost:3456/v1/models

# 채팅 완성
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw와 함께

프록시를 사용자 정의 OpenAI 호환 엔드포인트로 가리킬 수 있습니다:

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

| 모델 ID           | 맵:             |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS에서 자동 시작

LaunchAgent를 만들어 프록시를 자동으로 실행합니다:

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
- **문제:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 참고

- 이는 Anthropic 또는 OpenClaw에서 공식적으로 지원하지 않는 **커뮤니티 도구**입니다
- 활성 Claude Max/Pro 구독 및 Claude Code CLI 인증이 필요합니다
- 프록시는 로컬로 실행되며 타사 서버로 데이터를 보내지 않습니다
- 스트리밍 응답이 완전히 지원됩니다

## 참고: 도움말

- [Anthropic 제공자](/providers/anthropic) - Claude setup-token 또는 API 키를 사용한 네이티브 OpenClaw 통합
- [OpenAI 제공자](/providers/openai) - OpenAI/Codex 구독용
