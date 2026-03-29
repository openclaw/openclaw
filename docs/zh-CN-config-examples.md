# OpenClaw 配置示例

本文档提供各种配置示例。

## 基础配置

### 最小配置

```yaml
# openclaw.yaml
gateway:
  host: localhost
  port: 8080

defaultModel: kimi-coding/k2.5
```

### 完整配置

```yaml
# openclaw.yaml
gateway:
  host: 0.0.0.0
  port: 8080
  authToken: ${GATEWAY_TOKEN}

model:
  default: kimi-coding/k2.5
  providers:
    - id: openai
      apiKey: ${OPENAI_API_KEY}
    - id: anthropic
      apiKey: ${ANTHROPIC_API_KEY}

channels:
  telegram:
    botToken: ${TELEGRAM_BOT_TOKEN}
  discord:
    botToken: ${DISCORD_BOT_TOKEN}
    intents:
      - GUILDS
      - GUILD_MESSAGES

agents:
  - name: main
    model: kimi-coding/k2.5
    systemPrompt: 你是一个有帮助的助手
    
  - name: coder
    model: anthropic/claude-3
    systemPrompt: 你是一个专业的程序员
```

## 频道配置

### Telegram

```yaml
channels:
  telegram:
    botToken: ${TELEGRAM_BOT_TOKEN}
    allowedChats:
      - -123456789  # 群组 ID
    commands:
      - name: help
        description: 显示帮助
      - name: status
        description: 查看状态
```

### Discord

```yaml
channels:
  discord:
    botToken: ${DISCORD_BOT_TOKEN}
    intents:
      - GUILDS
      - GUILD_MESSAGES
      - DIRECT_MESSAGES
    activity:
      type: Playing
      name: "OpenClaw"
```

## Agent 配置

### 带工具的 Agent

```yaml
agents:
  - name: assistant
    model: kimi-coding/k2.5
    tools:
      - exec
      - web_search
      - github
    toolsPolicy:
      exec:
        allowedCommands:
          - git
          - npm
          - docker
        timeout: 30000
```

### 带 Hook 的 Agent

```yaml
agents:
  - name: smart-agent
    model: kimi-coding/k2.5
    hooks:
      before_agent_start:
        - type: set_context
          key: session_start
          value: ${DATE}
      after_tool_call:
        - type: log
          level: info
```

## 安全配置

```yaml
security:
  allowedIPs:
    - 127.0.0.1
    - 192.168.1.*
    
  sandbox:
    enabled: true
    dockerImage: openclaw/sandbox
    
  rateLimit:
    requestsPerMinute: 60
    burst: 10
```

## 环境变量

```bash
# .env
GATEWAY_TOKEN=your-gateway-token
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
DISCORD_BOT_TOKEN=MTIz...
```

## Docker 配置

```yaml
# docker-compose.yaml
version: '3.8'
services:
  openclaw:
    image: openclaw/openclaw:latest
    ports:
      - "8080:8080"
    environment:
      - GATEWAY_TOKEN=${GATEWAY_TOKEN}
      - DEFAULT_MODEL=kimi-coding/k2.5
    volumes:
      - ./data:/data
      - ~/.openclaw:/root/.openclaw
```

---

更多配置选项请参考官方文档。
