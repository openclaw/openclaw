# Security Model Lock 插件

自动在调用敏感工具时切换到安全模型，并锁定会话防止切换回其他模型。

## 功能特性

- 🔒 **敏感工具检测**：监控指定的工具调用（如 `weather`）
- 🔄 **自动模型切换**：检测到敏感工具时自动切换到配置的安全模型
- 🔐 **会话锁定**：锁定当前会话，防止切换回其他模型
- 📊 **状态查询**：通过命令查看锁定状态
- 🔓 **手动解锁**：支持手动解锁会话

## 安装

### 方式一：本地链接（开发）

```bash
cd D:\Projects\openclaw\extensions\security-model-lock
pnpm link
```

### 方式二：配置启用

在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "security-model-lock": {
      "enabled": true,
      "sensitiveTools": ["weather"],
      "secureModel": {
        "provider": "ollama",
        "model": "llama3.3:8b"
      }
    }
  }
}
```

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用插件 |
| `sensitiveTools` | string[] | `["weather"]` | 触发锁定的工具名称列表 |
| `secureModel.provider` | string | 必填 | 安全模型的 provider ID |
| `secureModel.model` | string | 必填 | 安全模型的 model ID |
| `lockNotice` | string | 默认提示 | 锁定时的提示消息 |

## 使用方式

### 1. 自动触发

当用户消息触发敏感工具调用时，插件会自动：
1. 检测到敏感工具（如 `weather`）
2. 锁定当前会话
3. 下次用户输入时自动切换到安全模型

### 2. 查询状态

```bash
/security-status
```

输出示例：
```
Security Model Lock Status: LOCKED

Locked at: 2026-03-04 10:30:00 (triggered by: weather)
Duration: 120s
Reason: Sensitive tool "weather" was called

All model calls will use the configured secure model.
Use /security-unlock to unlock this session.
```

### 3. 手动解锁

```bash
/security-unlock
```

## 工作流程

```
用户消息："今天天气如何？"
    ↓
Agent 决定调用 weather 工具
    ↓
before_tool_call hook 触发
    ↓
检测到 weather 是敏感工具
    ↓
锁定会话 (sessionKey -> locked)
    ↓
工具执行完成，返回结果
    ↓
用户继续提问
    ↓
before_model_resolve hook 触发
    ↓
检测到会话已锁定
    ↓
返回安全模型配置 (providerOverride, modelOverride)
    ↓
使用安全模型回复用户
```

## 注意事项

1. **同一 Turn 内无法切换**：工具调用发生在单次 agent run 内部，锁定后需要等到下一次用户输入才会切换模型

2. **会话级锁定**：锁定状态存储在内存中，重启 Gateway 后会重置。如需持久化，可修改插件添加文件存储

3. **命令拦截**：锁定后，`/model` 命令仍可以执行，但实际模型调用会使用安全模型

4. **多会话隔离**：每个会话的锁定状态是独立的，一个会话锁定不影响其他会话

## 扩展敏感工具列表

在配置中添加更多敏感工具：

```json
{
  "plugins": {
    "security-model-lock": {
      "sensitiveTools": ["weather", "execute_command", "access_database", "send_email"]
    }
  }
}
```

## 常见问题

### Q: 为什么工具调用后没有立即切换模型？

A: 工具调用发生在单次 agent run 的内部循环中，`before_model_resolve` hook 只在每次 agent run 开始时触发一次。需要等到下一次用户输入时才会切换模型。

### Q: 如何完全阻断敏感工具？

A: 修改 `index.ts` 中的 `before_tool_call` handler，返回阻断结果：

```typescript
return {
  block: true,
  blockReason: "此工具需要安全模式，请先配置安全模型"
};
```

### Q: 锁定状态会持久化吗？

A: 当前实现使用内存存储，重启后重置。可以通过修改 `sessionLocks` Map 添加文件持久化支持。

## 开发

### 目录结构

```
extensions/security-model-lock/
├── index.ts                      # 插件主文件
├── package.json                  # 包配置
├── openclaw.plugin.json          # 插件配置 schema
├── openclaw.json.example         # 使用示例
└── README.md                     # 本文档
```

### 测试

```bash
# 运行插件测试
pnpm test --filter @openclaw/security-model-lock
```

## License

MIT
