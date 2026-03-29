# OpenClaw API 使用示例

本文件提供 OpenClaw API 的常用示例。

## 基本用法

### 启动 Agent

```typescript
import { Client } from 'openclaw-sdk'

const client = new Client({
  gateway: 'http://localhost:8080'
})

// 创建新会话
const session = await client.sessions.create({
  model: 'kimi-coding/k2.5',
  systemPrompt: '你是一个有用的助手'
})

// 发送消息
const response = await session.send('你好！')
console.log(response.text)
```

### 使用 Tools

```typescript
// 执行特定工具
const result = await session.runTool('exec', {
  command: 'ls -la',
  timeout: 30000
})

// 使用 web search
const searchResult = await session.runTool('web_search', {
  query: 'OpenClaw AI framework',
  numResults: 5
})
```

### 管理 Channel

```typescript
// 添加 Telegram 频道
await client.channels.add({
  type: 'telegram',
  token: process.env.TELEGRAM_BOT_TOKEN
})

// 查看所有频道
const channels = await client.channels.list()
```

## 高级用法

### 自定义 Hook

```typescript
const client = new Client({
  hooks: {
    before_agent_start: async (context) => {
      console.log('Agent starting...')
      return context
    },
    after_tool_call: async (context) => {
      console.log('Tool called:', context.tool)
      return context
    }
  }
})
```

### 错误处理

```typescript
try {
  const response = await session.send('Hello')
} catch (error) {
  if (error.code === 'RATE_LIMIT') {
    // 处理速率限制
    await sleep(error.retryAfter)
    // 重试
  } else if (error.code === 'MODEL_UNAVAILABLE') {
    // 切换模型
    session.switchModel('gpt-4')
  }
}
```

## 完整示例

```typescript
import { Client } from 'openclaw-sdk'

async function main() {
  const client = new Client({
    gateway: 'http://localhost:8080',
    model: 'kimi-coding/k2.5'
  })
  
  // 创建会话
  const session = await client.createSession({
    systemPrompt: '你是一个专业的技术顾问'
  })
  
  // 对话
  const responses = await session.chat([
    '介绍一下 OpenClaw',
    '它和 LangChain 有什么区别?',
    '如何部署到生产环境?'
  ])
  
  responses.forEach(r => console.log(r.text))
}

main()
```

---

更多示例请访问: https://docs.openclaw.ai
