# replyToMode Workaround 解决方案

## 问题描述

在使用 Kimi 模型的 Telegram 群组中，引用/回复消息会触发 "high risk" 内容拦截。

## 解决方案

### 方案1: 禁用引用（当前使用）
```json
{
  "channels": {
    "telegram": {
      "replyToMode": "off"
    }
  }
}
```

### 方案2: 切换模型（推荐）
将受影响的 agent 从 Kimi 切换到 Claude：
```json
{
  "agents": {
    "list": [
      {
        "id": "editor",
        "model": "my_api/claude-opus-4-6"
      }
    ]
  }
}
```

## 最佳实践

- 私聊使用 Kimi
- 群组使用 Claude
- 需要时通过 DM 转发

---
贡献者: huangpi1030-tech
日期: 2026-03-18
