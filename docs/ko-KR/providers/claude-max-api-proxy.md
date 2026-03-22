---
summary: "Claude 구독 자격 증명을 OpenAI 호환 엔드포인트로 노출하는 커뮤니티 프록시"
read_when:
  - OpenAI 호환 도구에서 Claude Max 구독을 사용하고 싶을 때
  - Claude Code CLI 를 래핑하는 로컬 API 서버를 원할 때
  - 구독 기반 vs API 키 기반 Anthropic 액세스를 평가하고 싶을 때
title: "Claude Max API Proxy"
x-i18n:
  source_path: docs/providers/claude-max-api-proxy.md
---

# Claude Max API Proxy

**claude-max-api-proxy** 는 Claude Max/Pro 구독을 OpenAI 호환 API 엔드포인트로 노출하는 커뮤니티 도구입니다. 이를 통해 OpenAI API 형식을 지원하는 모든 도구에서 구독을 사용할 수 있습니다.

<Warning>
이 경로는 기술적 호환성만을 위한 것입니다. Anthropic 은 과거에 Claude Code 외부에서의 일부 구독
사용을 차단한 적이 있습니다. 사용 여부는 직접 판단해야 하며, 의존하기 전에 Anthropic 의 현재
약관을 확인하세요.
</Warning>

## 왜 사용하나요?

| 접근 방식       | 비용                                             | 적합한 경우                  |
| --------------- | ------------------------------------------------ | ---------------------------- |
| Anthropic API   | 토큰당 과금 (Opus 기준 입력 ~$15/M, 출력 ~$75/M) | 프로덕션 앱, 대량 사용       |
| Claude Max 구독 | 월 $200 정액                                     | 개인 사용, 개발, 무제한 사용 |

Claude Max 구독이 있고 OpenAI 호환 도구에서 사용하려는 경우, 이 프록시가 일부 워크플로우의 비용을 줄일 수 있습니다. 프로덕션 사용에는 API 키가 정책적으로 더 명확한 경로입니다.

## 작동 방식

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

프록시는:

1. `http://localhost:3456/v1/chat/completions` 에서 OpenAI 형식 요청을 수신합니다
2. Claude Code CLI 명령으로 변환합니다
3. OpenAI 형식으로 응답을 반환합니다 (스트리밍 지원)

## 설치

```bash
# Node.js 20+ 및 Claude Code CLI 필요
npm install -g claude-max-api-proxy

# Claude CLI 가 인증되었는지 확인
claude --version
```

## 사용법

### 서버 시작

```bash
claude-max-api
# 서버가 http://localhost:3456 에서 실행됩니다
```

### 테스트

```bash
# 상태 확인
curl http://localhost:3456/health

# 모델 목록
curl http://localhost:3456/v1/models

# 채팅 완성
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw 와 함께 사용

프록시를 사용자 정의 OpenAI 호환 엔드포인트로 OpenClaw 에 연결할 수 있습니다:

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

| 모델 ID           | 매핑 대상       |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## macOS 에서 자동 시작

프록시를 자동으로 실행하는 LaunchAgent 를 생성합니다:

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

- 이것은 Anthropic 또는 OpenClaw 에서 공식적으로 지원하지 않는 **커뮤니티 도구** 입니다
- Claude Code CLI 가 인증된 활성 Claude Max/Pro 구독이 필요합니다
- 프록시는 로컬에서 실행되며 제 3 자 서버로 데이터를 전송하지 않습니다
- 스트리밍 응답이 완전히 지원됩니다

## 참조

- [Anthropic 프로바이더](/providers/anthropic) - Claude setup-token 또는 API 키를 사용한 네이티브 OpenClaw 통합
- [OpenAI 프로바이더](/providers/openai) - OpenAI/Codex 구독용
