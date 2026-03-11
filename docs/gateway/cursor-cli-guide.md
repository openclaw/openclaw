---
summary: "Cursor CLI backend: use Cursor headless agent as OpenClaw provider"
read_when:
  - You want to use Cursor CLI as a model provider in OpenClaw
  - You are configuring cursor-cli backend for the first time
  - You need to troubleshoot Cursor CLI integration
title: "Cursor CLI Guide"
---

# Cursor CLI 集成指南

通过 `cursor-cli` 后端，OpenClaw 可以调用本地 Cursor headless CLI（`agent` 命令）
作为模型提供商，复用 Cursor 订阅的 AI 能力。

## 前置条件

1. 已安装 Cursor CLI（`agent` 命令在 PATH 中可用）
2. 已完成 Cursor CLI 认证
3. OpenClaw 已安装并配置

## 第一步：安装 Cursor CLI

```bash
# macOS / Linux / WSL
curl https://cursor.com/install -fsS | bash

# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex
```

验证安装：

```bash
agent --version
```

## 第二步：Cursor CLI 认证

两种方式任选其一：

### 方式一：浏览器登录（推荐）

```bash
agent login
agent status   # 确认已认证
```

### 方式二：API Key

在 [Cursor 设置页面](https://cursor.com/settings) 的
**Integrations > User API Keys** 中生成 API Key，然后：

```bash
export CURSOR_API_KEY=your_api_key_here
```

建议写入 shell 配置持久化：

```bash
echo 'export CURSOR_API_KEY=your_api_key_here' >> ~/.zshrc
source ~/.zshrc
```

## 第三步：查看可用模型

```bash
agent models
```

常见可用模型：

| 模型                  | 说明                        |
| --------------------- | --------------------------- |
| `sonnet-4.6-thinking` | Claude Sonnet 4.6（带推理） |
| `sonnet-4.6`          | Claude Sonnet 4.6           |
| `opus-4.6`            | Claude Opus 4.6             |
| `opus-4.6-thinking`   | Claude Opus 4.6（带推理）   |
| `gpt-5.4-high`        | GPT-5.4 High                |
| `gemini-3.1-pro`      | Gemini 3.1 Pro              |
| `auto`                | 自动选择                    |

## 第四步：配置 OpenClaw 默认模型

```bash
openclaw config set agents.defaults.model.primary cursor-cli/sonnet-4.6-thinking
```

或手动编辑 `~/.openclaw/openclaw.json5`：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "cursor-cli/sonnet-4.6-thinking",
      },
    },
  },
}
```

## 第五步：重启 Gateway

```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

验证：

```bash
openclaw channels status --probe
tail -20 /tmp/openclaw-gateway.log
```

## 第六步：飞书配对（如使用飞书频道）

首次在飞书上给 bot 发消息时会收到配对提示，按提示操作：

```bash
# 查看待批准的配对请求
openclaw pairing list

# 批准配对（使用实际的配对码）
openclaw pairing approve feishu <PAIRING_CODE>
```

## 使用方式

### 直接指定模型

```bash
openclaw agent --message "hello" --model cursor-cli/sonnet-4.6-thinking
```

### 作为 fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["cursor-cli/sonnet-4.6-thinking"],
      },
    },
  },
}
```

### 自定义 command 路径

如果 `agent` 不在 PATH 中（常见于 launchd/systemd 环境）：

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "cursor-cli": {
          command: "/usr/local/bin/agent",
        },
      },
    },
  },
}
```

## 故障排查

### "Cannot use this model" 错误

运行 `agent models` 查看可用模型列表，确保使用的模型 ID 完全匹配。
例如使用 `sonnet-4.6-thinking` 而非 `claude-4-sonnet`。

### "No API key found for provider" 错误

默认模型可能仍指向 `anthropic/...`，需切换到 `cursor-cli/...`：

```bash
openclaw config set agents.defaults.model.primary cursor-cli/sonnet-4.6-thinking
```

### "access not configured" / 配对码错误

配对码有有效期，过期后需在飞书重新发消息获取新码，然后立即批准：

```bash
openclaw pairing list
openclaw pairing approve feishu <NEW_CODE>
```

### CLI 找不到

设置 `command` 为绝对路径：

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "cursor-cli": {
          command: "/usr/local/bin/agent",
        },
      },
    },
  },
}
```

### 查看日志

```bash
openclaw logs --follow
tail -f /tmp/openclaw-gateway.log
```

## 技术细节

- Cursor CLI 命令名为 `agent`（不是 `cursor`）
- 使用 `--force` 标志允许代理直接修改文件
- 会话恢复通过 `--resume <sessionId>` 实现
- JSON 输出中 `result` 字段为回复文本，`session_id` 用于会话跟踪
- 参考文档：[Cursor CLI Headless](https://cursor.com/docs/cli/headless)、
  [Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)、
  [Cursor CLI 认证](https://cursor.com/docs/cli/reference/authentication)
