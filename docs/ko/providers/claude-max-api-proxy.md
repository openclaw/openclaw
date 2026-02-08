---
read_when:
    - OpenAI 호환 도구와 함께 Claude Max 구독을 사용하고 싶습니다.
    - Claude Code CLI를 래핑하는 로컬 API 서버가 필요합니다.
    - API 키 대신 구독을 사용하여 비용을 절약하고 싶습니다.
summary: Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 사용
title: 클로드 맥스 API 프록시
x-i18n:
    generated_at: "2026-02-08T16:05:26Z"
    model: gtx
    provider: google-translate
    source_hash: 43d0ab1461dd6f1da7974b54bd9c8fe033ad3abbad892953baad4a93c8b16b5b
    source_path: providers/claude-max-api-proxy.md
    workflow: 15
---

# 클로드 맥스 API 프록시

**클로드-맥스-API-프록시** Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 노출하는 커뮤니티 도구입니다. 이를 통해 OpenAI API 형식을 지원하는 모든 도구에서 구독을 사용할 수 있습니다.

## 왜 이것을 사용합니까?

| Approach                | Cost                                                | Best For                                   |
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |
| Anthropic API           | Pay per token (~$15/M input, $75/M output for Opus) | Production apps, high volume               |
| Claude Max subscription | $200/month flat                                     | Personal use, development, unlimited usage |

Claude Max 구독이 있고 이를 OpenAI 호환 도구와 함께 사용하려는 경우 이 프록시를 사용하면 상당한 비용을 절약할 수 있습니다.

## 작동 방식

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

프록시:

1. 다음에서 OpenAI 형식 요청을 수락합니다. `http://localhost:3456/v1/chat/completions`
2. Claude Code CLI 명령으로 변환합니다.
3. OpenAI 형식으로 응답을 반환합니다(스트리밍 지원)

## 설치

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## 용법

### 서버 시작

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### 테스트해 보세요

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

### 오픈클로와 함께

프록시에서 OpenClaw를 사용자 지정 OpenAI 호환 엔드포인트로 지정할 수 있습니다.

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

| Model ID          | Maps To         |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS에서 자동 시작

프록시를 자동으로 실행하려면 LaunchAgent를 만듭니다.

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

## 모래밭

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **문제:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## 메모

- 이것은 **커뮤니티 도구**, Anthropic 또는 OpenClaw에서는 공식적으로 지원되지 않습니다.
- Claude Code CLI가 인증된 활성 Claude Max/Pro 구독이 필요합니다.
- 프록시는 로컬로 실행되며 타사 서버로 데이터를 보내지 않습니다.
- 스트리밍 응답이 완벽하게 지원됩니다.

## 참조

- [인류 공급자](/providers/anthropic) - Claude 설정 토큰 또는 API 키와 기본 OpenClaw 통합
- [OpenAI 제공업체](/providers/openai) - OpenAI/Codex 구독의 경우
