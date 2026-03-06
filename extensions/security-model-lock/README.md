# Security Model Lock 插件

自动在调用敏感 skill 时切换到安全模型，并锁定会话防止切换回其他模型。

## 功能特性

- 🔒 **敏感 Skill 检测**：通过检测 `read` 工具读取 `SKILL.md` 文件来识别 skill 调用
- 🔄 **自动模型切换**：检测到敏感 skill 时自动切换到配置的安全模型
- 🔐 **会话锁定**：锁定当前会话，防止切换回其他模型
- 📊 **状态查询**：通过命令查看锁定状态
- 🔓 **手动解锁**：支持手动解锁会话

## 工作原理

### Skill 调用检测

当 LLM 调用 skill 时，会先读取对应的 `SKILL.md` 文件：

```json
{
  "type": "toolCall",
  "name": "read",
  "arguments": {
    "file_path": "/app/skills/weather/SKILL.md"
  }
}
```

插件通过 `before_tool_call` hook 拦截 `read` 工具，检查 `file_path` 是否指向敏感 skill 目录。

### 阻断与锁定

检测到敏感 skill 调用时：
1. **阻断 read 工具**（不读取 skill 文件）
2. 锁定当前会话
3. 返回提示消息给用户
4. 用户重新发送消息时，使用安全模型处理

## 安装

### 前置条件

插件必须放在 OpenClaw 可以扫描到的位置。默认扫描路径包括：

1. `extensions/` 目录（项目根目录下）
2. `~/.openclaw/plugins/`（用户目录）
3. 通过 `plugins.load.paths` 配置的自定义路径

### 方式一：使用项目内置插件（开发）

如果插件在 `extensions/` 目录下，OpenClaw 会自动发现。

### 方式二：配置自定义加载路径

在 `openclaw.json` 中添加插件加载路径：

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/your/plugins/security-model-lock"
      ]
    },
    "entries": {
      "security-model-lock": {
        "enabled": true,
        "config": {
          "sensitiveSkills": ["weather"],
          "secureModel": {
            "provider": "ollama",
            "model": "llama3.3:8b"
          }
        }
      }
    }
  }
}
```

### 方式三：复制到用户插件目录

```bash
# Linux/WSL
cp -r extensions/security-model-lock ~/.openclaw/plugins/

# Windows (PowerShell)
Copy-Item -Recurse extensions\security-model-lock $env:USERPROFILE\.openclaw\plugins\
```

然后在配置中启用：

```json
{
  "plugins": {
    "entries": {
      "security-model-lock": {
        "enabled": true,
        "config": {
          "sensitiveSkills": ["weather"],
          "secureModel": {
            "provider": "ollama",
            "model": "llama3.3:8b"
          }
        }
      }
    }
  }
}
```

**注意**：
- 插件配置必须放在 `plugins.entries` 下
- `config` 字段包含插件的具体配置项
- 插件必须被 OpenClaw 发现后，配置验证才会通过

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用插件 |
| `sensitiveSkills` | string[] | `["weather"]` | 触发锁定的 skill 名称列表 |
| `secureModel.provider` | string | 必填 | 安全模型的 provider ID |
| `secureModel.model` | string | 必填 | 安全模型的 model ID |
| `lockNotice` | string | 默认提示 | 锁定时的提示消息 |
| `skillsDir` | string | 自动检测 | 可选：自定义 skills 目录路径 |

## 使用方式

### 1. 自动触发（阻断模式）

```
用户："今天天气如何？"
    ↓
LLM 决定调用 weather skill
    ↓
LLM 调用 read 工具读取 /app/skills/weather/SKILL.md
    ↓
before_tool_call 检测到敏感 skill 文件
    ↓
阻断 read 工具 + 锁定会话
    ↓
用户看到："检测到敏感 skill 调用，已切换到安全模型。请重新发送消息。"
    ↓
用户重新发送："今天天气如何？"
    ↓
before_model_resolve 检测到锁定
    ↓
使用安全模型回复
```

### 2. 查询状态

```bash
/security-status
```

输出示例：
```
Security Model Lock Status: LOCKED

Locked at: 2026-03-04 10:30:00 (triggered by: weather)
Duration: 120s
Reason: Sensitive skill "weather" was accessed via read tool

All model calls will use the configured secure model.
Use /security-unlock to unlock this session.
```

### 3. 手动解锁

```bash
/security-unlock
```

## 配置示例

### 监控天气 skill

```json
{
  "plugins": {
    "entries": {
      "security-model-lock": {
        "enabled": true,
        "config": {
          "sensitiveSkills": ["weather"],
          "secureModel": {
            "provider": "ollama",
            "model": "llama3.3:8b"
          }
        }
      }
    }
  }
}
```

### 监控多个 skills

```json
{
  "plugins": {
    "entries": {
      "security-model-lock": {
        "enabled": true,
        "config": {
          "sensitiveSkills": ["weather", "notion", "slack"],
          "secureModel": {
            "provider": "local",
            "model": "qwen2.5:7b"
          }
        }
      }
    }
  }
}
```

### 自定义 Skills 目录

```json
{
  "plugins": {
    "entries": {
      "security-model-lock": {
        "enabled": true,
        "config": {
          "sensitiveSkills": ["weather"],
          "skillsDir": "/custom/path/to/skills",
          "secureModel": {
            "provider": "ollama",
            "model": "llama3.3:8b"
          }
        }
      }
    }
  }
}
```

## 工作流程

```
用户消息："今天天气如何？"
    ↓
Agent 准备调用 weather skill
    ↓
LLM 调用 read 工具读取 SKILL.md
    ↓
before_tool_call hook 触发
    ↓
检查 file_path: /app/skills/weather/SKILL.md
    ↓
检测到 weather 是敏感 skill
    ↓
锁定会话 (sessionKey -> locked)
    ↓
**阻断 read 工具** ← skill 文件不会被读取
    ↓
返回错误消息："检测到敏感 skill 调用，已切换到安全模型。请重新发送消息。"
    ↓
用户看到提示，重新发送："今天天气如何？"
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

1. **阻断后需重新发送**：敏感 skill 被阻断后，用户需要重新发送消息，新消息会使用安全模型处理

2. **Skill 文件路径匹配**：插件通过检查 `read` 工具的 `file_path` 参数是否包含敏感 skill 目录名来识别

3. **会话级锁定**：锁定状态存储在内存中，重启 Gateway 后会重置

4. **多会话隔离**：每个会话的锁定状态是独立的，一个会话锁定不影响其他会话

5. **自动检测 Skills 目录**：插件会自动扫描以下目录：
   - 当前工作目录的 `skills/`
   - `~/.openclaw/skills/`
   - 配置的 `skillsDir`（如果有）

## 常见问题

### Q: 阻断后会发生什么？

A: 敏感 skill 被阻断后，用户会看到提示消息："检测到敏感 skill 调用，已切换到安全模型。请重新发送消息。"用户重新发送消息后，插件会在 `before_model_resolve` hook 中检测到会话已锁定，并返回安全模型配置。

### Q: 如果不希望阻断，只是平滑切换模型？

A: 修改 `index.ts` 中的 `before_tool_call` handler，移除阻断返回：

```typescript
// 删除或注释掉：
return {
  block: true,
  blockReason: config.lockNotice
};
```

### Q: 锁定状态会持久化吗？

A: 当前实现使用内存存储，重启后重置。可以通过修改 `sessionLocks` Map 添加文件持久化支持。

### Q: 如果 skill 目录名与 skill name 不同怎么办？

A: 插件通过扫描 `SKILL.md` 文件中的 `name` 字段来识别 skill 名称，并通过检查文件路径是否包含敏感 skill 名称来匹配。确保 `sensitiveSkills` 中的名称与 `SKILL.md` 中的 `name` 字段匹配。

## 开发

### 目录结构

```
extensions/security-model-lock/
├── index.ts                      # 插件主文件
├── package.json                  # 包配置
├── openclaw.plugin.json          # 插件配置 schema
├── openclaw.json.example         # 使用示例
├── README.md                     # 本文档
└── index.test.ts                 # 单元测试
```

### 测试

```bash
# 运行插件测试
pnpm test --filter @openclaw/security-model-lock
```

## License

MIT
