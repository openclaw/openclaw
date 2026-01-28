---
read_when:
  - 新手引导新的助手实例
  - 审查安全/权限影响
summary: 将 OpenClaw 作为个人助手运行的端到端指南，包含安全注意事项
title: 个人助手设置
x-i18n:
  generated_at: "2026-02-01T21:39:04Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 2763668c053abe34ea72c40d1306d3d1143099c58b1e3ef91c2e5a20cb2769e0
  source_path: start/openclaw.md
  workflow: 15
---

# 使用 OpenClaw 构建个人助手

OpenClaw 是一个面向 **Pi** 智能体的 WhatsApp + Telegram + Discord + iMessage Gateway网关。插件可添加 Mattermost 支持。本指南介绍"个人助手"设置：一个专用的 WhatsApp 号码，作为你始终在线的智能体。

## ⚠️ 安全第一

你正在让一个智能体拥有以下能力：

- 在你的机器上运行命令（取决于你的 Pi 工具设置）
- 读写你工作区中的文件
- 通过 WhatsApp/Telegram/Discord/Mattermost（插件）发送消息

请从保守配置开始：

- 始终设置 `channels.whatsapp.allowFrom`（切勿在你的个人 Mac 上以对全网开放的方式运行）。
- 为助手使用专用的 WhatsApp 号码。
- 心跳现在默认每 30 分钟一次。在你信任该设置之前，通过设置 `agents.defaults.heartbeat.every: "0m"` 来禁用。

## 前提条件

- Node **22+**
- OpenClaw 在 PATH 中可用（推荐：全局安装）
- 为助手准备一个第二个电话号码（SIM/eSIM/预付费卡）

```bash
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest
```

从源码安装（开发模式）：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
pnpm link --global
```

## 双手机设置（推荐）

你需要的配置如下：

```
你的手机（个人）                第二部手机（助手）
┌─────────────────┐           ┌─────────────────┐
│  你的 WhatsApp  │  ──────▶  │  助手 WA        │
│  +1-555-YOU     │  消息     │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ 通过二维码关联
                                       ▼
                              ┌─────────────────┐
                              │  你的 Mac       │
                              │  (openclaw)      │
                              │    Pi 智能体    │
                              └─────────────────┘
```

如果你将个人 WhatsApp 关联到 OpenClaw，发给你的每条消息都会变成"智能体输入"。这通常不是你想要的。

## 5 分钟快速上手

1. 配对 WhatsApp Web（显示二维码；用助手手机扫描）：

```bash
openclaw channels login
```

2. 启动 Gateway网关（保持运行）：

```bash
openclaw gateway --port 18789
```

3. 在 `~/.openclaw/openclaw.json` 中放置一个最小配置：

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

现在从你的允许列表手机给助手号码发消息。

新手引导完成后，我们会自动打开带有 Gateway网关令牌的仪表盘并打印令牌化链接。以后重新打开：`openclaw dashboard`。

## 给智能体一个工作区（AGENTS）

OpenClaw 从其工作区目录读取操作指令和"记忆"。

默认情况下，OpenClaw 使用 `~/.openclaw/workspace` 作为智能体工作区，并会在设置/首次智能体运行时自动创建它（以及初始的 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`）。`BOOTSTRAP.md` 仅在工作区全新创建时生成（删除后不会再次出现）。

提示：将此文件夹视为 OpenClaw 的"记忆"，并将其设为 git 仓库（最好是私有的），以便你的 `AGENTS.md` + 记忆文件得到备份。如果安装了 git，全新工作区会自动初始化。

```bash
openclaw setup
```

完整工作区布局 + 备份指南：[智能体工作区](/concepts/agent-workspace)
记忆工作流：[记忆](/concepts/memory)

可选：使用 `agents.defaults.workspace` 选择不同的工作区（支持 `~`）。

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

如果你已经从仓库中提供了自己的工作区文件，可以完全禁用引导文件创建：

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## 将其变成"助手"的配置

OpenClaw 默认提供了良好的助手设置，但你通常会想要调整：

- `SOUL.md` 中的人设/指令
- 思考默认值（如需要）
- 心跳（在你信任之后）

示例：

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-5",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## 会话和记忆

- 会话文件：`~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- 会话元数据（令牌用量、最后路由等）：`~/.openclaw/agents/<agentId>/sessions/sessions.json`（旧版：`~/.openclaw/sessions/sessions.json`）
- `/new` 或 `/reset` 为该聊天启动新会话（可通过 `resetTriggers` 配置）。如果单独发送，智能体会回复一条简短的问候以确认重置。
- `/compact [instructions]` 压缩会话上下文并报告剩余的上下文预算。

## 心跳（主动模式）

默认情况下，OpenClaw 每 30 分钟运行一次心跳，提示词为：
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
设置 `agents.defaults.heartbeat.every: "0m"` 可禁用。

- 如果 `HEARTBEAT.md` 存在但实际为空（仅包含空行和 markdown 标题如 `# Heading`），OpenClaw 会跳过心跳运行以节省 API 调用。
- 如果文件不存在，心跳仍会运行，由模型决定执行什么操作。
- 如果智能体回复 `HEARTBEAT_OK`（可选带有短填充内容；参见 `agents.defaults.heartbeat.ackMaxChars`），OpenClaw 会抑制该次心跳的出站消息投递。
- 心跳运行完整的智能体回合——较短的间隔会消耗更多令牌。

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## 媒体输入和输出

入站附件（图片/音频/文档）可通过模板传递给你的命令：

- `{{MediaPath}}`（本地临时文件路径）
- `{{MediaUrl}}`（伪 URL）
- `{{Transcript}}`（如果启用了音频转录）

智能体的出站附件：在单独一行中包含 `MEDIA:<path-or-url>`（无空格）。示例：

```
Here's the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw 会提取这些内容并将其作为媒体与文本一起发送。

## 运维清单

```bash
openclaw status          # 本地状态（凭证、会话、排队事件）
openclaw status --all    # 完整诊断（只读，可粘贴）
openclaw status --deep   # 添加 Gateway网关健康探测（Telegram + Discord）
openclaw health --json   # Gateway网关健康快照（WS）
```

日志位于 `/tmp/openclaw/`（默认：`openclaw-YYYY-MM-DD.log`）。

## 后续步骤

- 网页聊天：[网页聊天](/web/webchat)
- Gateway网关运维：[Gateway网关运维手册](/gateway)
- 定时任务 + 唤醒：[定时任务](/automation/cron-jobs)
- macOS 菜单栏伴侣应用：[OpenClaw macOS 应用](/platforms/macos)
- iOS 节点应用：[iOS 应用](/platforms/ios)
- Android 节点应用：[Android 应用](/platforms/android)
- Windows 状态：[Windows (WSL2)](/platforms/windows)
- Linux 状态：[Linux 应用](/platforms/linux)
- 安全：[安全](/gateway/security)
