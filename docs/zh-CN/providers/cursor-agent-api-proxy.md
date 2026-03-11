---
summary: "将 Cursor CLI 包装为 OpenAI 兼容 API 服务的社区工具"
read_when:
  - 你想将 Cursor 订阅与 OpenAI 兼容工具配合使用
  - 你想要一个封装 Cursor CLI (agent) 的本地 API 服务器
  - 你想通过订阅而非按量计费来使用 Cursor 模型
title: "Cursor Agent API 代理"
---

# Cursor Agent API 代理

**cursor-agent-api-proxy** 是一个社区工具，将 [Cursor CLI](https://cursor.com/cn/docs/cli/headless)（`agent` 命令）包装为 OpenAI 兼容的 API 服务。让你的 Cursor 订阅（Pro / Business）可以被任何支持 OpenAI 格式的工具直接调用。

<Warning>
这是一个技术兼容方案。通过自动化/代理方式使用 Cursor CLI 可能与 Cursor 的服务条款冲突。
在生产环境使用前，请自行确认 Cursor 的当前条款。
</Warning>

支持 macOS、Linux、Windows。

## 工作原理

```
你的应用 → cursor-agent-api-proxy → Cursor CLI (agent) → Cursor（通过订阅）
  （OpenAI 格式）                     （stream-json）        （使用你的登录凭据）
```

## 安装

需要 Node.js 20+ 和有效的 Cursor 订阅。

```bash
# 1. 安装并认证 Cursor CLI
curl https://cursor.com/install -fsS | bash
agent login
agent --list-models   # 确认 CLI 可用

# 2. 安装并启动代理
npm install -g cursor-agent-api-proxy
cursor-agent-api      # 后台启动，默认 http://localhost:4646

# 3. 验证
curl http://localhost:4646/health
```

<Tip>
**无头环境：** 跳过 `agent login`，改为设置 `CURSOR_API_KEY` 环境变量。
到 [cursor.com/settings](https://cursor.com/settings) 生成 API Key。
</Tip>

## 配合 OpenClaw 使用

### onboard 向导

运行 `openclaw onboard` 时，在 **Model/Auth** 步骤：

1. Provider 类型 → **Custom Provider**（OpenAI-compatible）
2. Base URL → `http://localhost:4646/v1`
3. API Key → 输入 `not-needed`
4. Default model → `auto`

### 编辑配置文件

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:4646/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/auto" },
    },
  },
}
```

<Note>
已通过 `agent login` 认证时，`OPENAI_API_KEY` 设为 `"not-needed"` 即可。
如需按请求转发特定的 Cursor API Key，填在这里。
</Note>

## 模型

模型 ID 和 `agent --list-models` 输出一致：

| Model ID              | 说明                           |
| --------------------- | ------------------------------ |
| `auto`                | 自动选择                       |
| `gpt-5.2`            | GPT-5.2                        |
| `gpt-5.3-codex`      | GPT-5.3 Codex                  |
| `opus-4.6-thinking`  | Claude Opus 4.6 (thinking)     |
| `sonnet-4.5-thinking`| Claude Sonnet 4.5 (thinking)   |
| `gemini-3-pro`       | Gemini 3 Pro                   |

完整列表：`curl http://localhost:4646/v1/models` 或 `agent --list-models`。

## 进程管理

```bash
cursor-agent-api              # 启动（后台）
cursor-agent-api stop         # 停止
cursor-agent-api restart      # 重启
cursor-agent-api status       # 查看状态
cursor-agent-api run          # 前台运行（调试用）
```

## 开机自启

注册为系统服务（跨平台）：

```bash
cursor-agent-api install      # 注册并启动
cursor-agent-api uninstall    # 移除
```

- macOS → LaunchAgent
- Windows → Task Scheduler
- Linux → systemd user service

## 链接

- **npm:** [https://www.npmjs.com/package/cursor-agent-api-proxy](https://www.npmjs.com/package/cursor-agent-api-proxy)
- **GitHub:** [https://github.com/tageecc/cursor-agent-api-proxy](https://github.com/tageecc/cursor-agent-api-proxy)
- **Issues:** [https://github.com/tageecc/cursor-agent-api-proxy/issues](https://github.com/tageecc/cursor-agent-api-proxy/issues)

## 注意事项

- 这是一个**社区工具**，并非由 Cursor 或 OpenClaw 官方支持
- 需要有效的 Cursor 订阅（Pro / Business）并已认证 CLI
- 代理在本地运行，不会将数据发送到任何第三方服务器
- 完全支持流式响应

## 另请参阅

- [Claude Max API 代理](/providers/claude-max-api-proxy) - 类似的 Claude 订阅代理
- [OpenAI 提供商](/providers/openai) - 适用于 OpenAI/Codex 订阅
