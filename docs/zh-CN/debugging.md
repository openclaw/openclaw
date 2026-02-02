---
read_when:
  - 需要检查原始模型输出中的推理泄漏
  - 希望在迭代开发时以监视模式运行 Gateway网关
  - 需要可重复的调试工作流
summary: 调试工具：监视模式、原始模型流和推理泄漏追踪
title: 调试
x-i18n:
  generated_at: "2026-02-01T20:24:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 504c824bff4790006c8b73600daca66b919e049178e9711e6e65b6254731911a
  source_path: debugging.md
  workflow: 14
---

# 调试

本页介绍流式输出的调试辅助工具，尤其适用于提供商将推理内容混入正常文本的情况。

## 运行时调试覆盖

在聊天中使用 `/debug` 设置**仅运行时**的配置覆盖（仅内存，不写入磁盘）。
`/debug` 默认禁用；通过 `commands.debug: true` 启用。
当你需要切换一些不常用的设置而又不想编辑 `openclaw.json` 时，这非常方便。

示例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 会清除所有覆盖项，恢复为磁盘上的配置。

## Gateway网关监视模式

要快速迭代，可在文件监视器下运行 Gateway网关：

```bash
pnpm gateway:watch --force
```

对应命令为：

```bash
tsx watch src/entry.ts gateway --force
```

在 `gateway:watch` 后添加任何 Gateway网关 CLI 标志，它们会在每次重启时被透传。

## 开发配置文件 + 开发 Gateway网关（--dev）

使用开发配置文件来隔离状态，搭建一个安全的、可随时丢弃的调试环境。有**两个** `--dev` 标志：

- **全局 `--dev`（配置文件）：** 将状态隔离到 `~/.openclaw-dev`，并将 Gateway网关默认端口设为 `19001`（派生端口随之偏移）。
- **`gateway --dev`：告诉 Gateway网关在缺少配置和工作区时自动创建默认配置 + 工作区**（并跳过 BOOTSTRAP.md）。

推荐流程（开发配置文件 + 开发引导）：

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

如果你还没有全局安装，可通过 `pnpm openclaw ...` 运行 CLI。

具体效果：

1. **配置文件隔离**（全局 `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001`（浏览器/画布端口随之偏移）

2. **开发引导**（`gateway --dev`）
   - 如缺少配置则写入最小配置（`gateway.mode=local`，绑定 local loopback）。
   - 将 `agent.workspace` 设为开发工作区。
   - 设置 `agent.skipBootstrap=true`（不使用 BOOTSTRAP.md）。
   - 如缺少工作区文件则进行初始化：
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - 默认身份：**C3‑PO**（礼仪机器人）。
   - 在开发模式下跳过渠道提供商（`OPENCLAW_SKIP_CHANNELS=1`）。

重置流程（全新开始）：

```bash
pnpm gateway:dev:reset
```

注意：`--dev` 是一个**全局**配置文件标志，可能会被某些运行器吞掉。
如需显式指定，请使用环境变量形式：

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 会清除配置、凭据、会话和开发工作区（使用 `trash` 而非 `rm`），然后重新创建默认的开发环境。

提示：如果非开发 Gateway网关已在运行（launchd/systemd），请先停止它：

```bash
openclaw gateway stop
```

## 原始流日志（OpenClaw）

OpenClaw 可以在任何过滤/格式化之前记录**原始助手流**。
这是查看推理内容是以纯文本增量到达还是以独立思考块到达的最佳方式。

通过 CLI 启用：

```bash
pnpm gateway:watch --force --raw-stream
```

可选的路径覆盖：

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

等效的环境变量：

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

默认文件：

`~/.openclaw/logs/raw-stream.jsonl`

## 原始数据块日志（pi-mono）

要在解析为块之前捕获**原始 OpenAI 兼容数据块**，pi-mono 提供了一个独立的日志记录器：

```bash
PI_RAW_STREAM=1
```

可选路径：

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

默认文件：

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意：此日志仅由使用 pi-mono 的 `openai-completions` 提供商的进程生成。

## 安全注意事项

- 原始流日志可能包含完整的提示词、工具输出和用户数据。
- 请将日志保存在本地，调试完成后及时删除。
- 如需分享日志，请先清除密钥和个人身份信息。
