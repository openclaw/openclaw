# OpenClaw 技能开发指南

学习如何创建自定义技能。

## 什么是技能？

技能（Skill）是扩展 OpenClaw 功能的模块，可以添加新的工具和能力。

## 快速开始

### 创建技能结构

```
~/.openclaw/skills/
└── my-skill/
    ├── SKILL.md          # 技能描述
    └── src/
        └── index.ts      # 技能代码
```

### SKILL.md 格式

```markdown
# My Skill

## Description
这是一个示例技能

## Tools
- `my_tool`: 执行某个操作

## Usage
通过自然语言调用
```

### 基本技能代码

```typescript
// src/index.ts
import { Skill, Tool } from 'openclaw'

export const skill: Skill = {
  id: 'my-skill',
  name: 'My Skill',
  description: '我的第一个技能',
  
  tools: [
    {
      name: 'my_tool',
      description: '执行某个操作',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        },
        required: ['input']
      },
      execute: async (params, context) => {
        return {
          result: `处理: ${params.input}`
        }
      }
    }
  ]
}
```

## 技能类型

### 1. 工具技能

```typescript
export const tool: Tool = {
  name: 'weather',
  description: '查询天气',
  parameters: {/* ... */},
  execute: async (params) => {
    const data = await fetchWeather(params.city)
    return data
  }
}
```

### 2. 触发器技能

```typescript
export const trigger = {
  on: 'message',
  handler: async (message, context) => {
    if (message.text.includes('hello')) {
      return { response: '你好！' }
    }
  }
}
```

### 3. 钩子技能

```typescript
export const hooks = {
  before_agent_start: async (context) => {
    // Agent 启动前执行
    return context
  },
  after_tool_call: async (context) => {
    // 工具调用后执行
    return context
  }
}
```

## 完整示例：天气技能

### SKILL.md

```markdown
# Weather Skill

查询全球城市天气信息。

## Tools
- `weather`: 查询指定城市的天气

## Example
"北京天气怎么样？"
```

### src/index.ts

```typescript
import { Skill } from 'openclaw'

export const skill: Skill = {
  id: 'weather',
  name: 'Weather',
  description: '查询天气',
  
  tools: [{
    name: 'weather',
    description: '获取城市天气',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名称' }
      },
      required: ['city']
    },
    execute: async ({ city }) => {
      // 使用天气 API
      const response = await fetch(
        `https://api.weather.example?city=${city}`
      )
      const data = await response.json()
      
      return {
        city: data.city,
        temp: data.temperature,
        condition: data.condition,
        humidity: data.humidity
      }
    }
  }]
}
```

## 测试技能

```bash
# 列出已安装技能
openclaw skills list

# 测试技能
openclaw skills test weather

# 查看技能日志
openclaw skills logs weather
```

## 发布技能

1. 创建 GitHub 仓库
2. 添加 SKILL.md
3. 测试通过后发布到 ClawHub

```bash
clawhub publish
```

## 最佳实践

1. 清晰的文档
2. 完善的错误处理
3. 适当的超时设置
4. 日志记录

---

开始创建你的第一个技能吧！
