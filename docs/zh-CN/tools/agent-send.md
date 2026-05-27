---
read_when:
  - 添加或修改智能体 CLI 入口点
summary: 直接 `openclaw agent` CLI 运行（带可选投递）
title: Agent Send
x-i18n:
  generated_at: "2026-02-03T07:54:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a84d6a304333eebe155da2bf24cf5fc0482022a0a48ab34aa1465cd6e667022d
  source_path: tools/agent-send.md
  workflow: 15
---

# `openclaw agent`（直接智能体运行）

`openclaw agent` 运行单个智能体回合，无需入站聊天消息。
默认情况下它**通过 Gateway 网关**运行；添加 `--local` 以强制在当前机器上使用嵌入式运行时。

## 行为

- 必需：`--message <text>`
- 会话选择：
  - `--to <dest>` 派生会话键（群组/频道目标保持隔离；直接聊天折叠到 `main`），**或**
  - `--session-id <id>` 通过 ID 重用现有会话，**或**
  - `--agent <id>` 直接定位已配置的智能体（使用该智能体的 `main` 会话键）
- 运行与正常入站回复相同的嵌入式智能体运行时。
- 思考/详细标志持久化到会话存储中。
- 输出：
  - 默认：打印回复文本（加上 `MEDIA:<url>` 行）
  - `--json`：打印结构化负载 + 元数据
- 可选使用 `--deliver` + `--channel` 将回复投递回渠道（目标格式与 `openclaw message --target` 匹配）。
- 使用 `--reply-channel`/`--reply-to`/`--reply-account` 覆盖投递而不更改会话。

如果 Gateway 网关不可达，CLI 会**回退**到嵌入式本地运行。

## 示例

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 标志

- `--local`：本地运行（需要你的 shell 中有模型提供商 API 密钥）
- `--deliver`：将回复发送到所选渠道
- `--channel`：投递渠道（`whatsapp|telegram|discord|googlechat|slack|signal|imessage`，默认：`whatsapp`）
- `--reply-to`：投递目标覆盖
- `--reply-channel`：投递渠道覆盖
- `--reply-account`：投递账户 ID 覆盖
- `--thinking <off|minimal|low|medium|high|xhigh>`：持久化思考级别（仅限 GPT-5.2 + Codex 模型）
- `--verbose <on|full|off>`：持久化详细级别
- `--timeout <seconds>`：覆盖智能体超时
- `--json`：输出结构化 JSON
