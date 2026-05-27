---
read_when:
  - 你需要检查原始模型输出以查找推理泄漏
  - 你想在迭代时以监视模式运行 Gateway 网关
  - 你需要可重复的调试工作流
summary: 调试工具：监视模式、原始模型流和追踪推理泄漏
title: 调试
x-i18n:
  generated_at: "2026-02-03T07:47:23Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 504c824bff4790006c8b73600daca66b919e049178e9711e6e65b6254731911a
  source_path: help/debugging.md
  workflow: 15
---

# 调试

本页介绍用于流式输出的调试辅助工具，特别是当提供商将推理混入正常文本时。

## 运行时调试覆盖

在聊天中使用 `/debug` 设置**仅运行时**配置覆盖（内存中，不写入磁盘）。
`/debug` 默认禁用；通过 `commands.debug: true` 启用。
当你需要切换不常用的设置而不编辑 `openclaw.json` 时，这非常方便。

示例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 清除所有覆盖并返回到磁盘上的配置。

## Gateway 网关监视模式

为了快速迭代，在文件监视器下运行 Gateway 网关：

```bash
pnpm gateway:watch --force
```

这映射到：

```bash
tsx watch src/entry.ts gateway --force
```

在 `gateway:watch` 后添加任何 Gateway 网关 CLI 标志，它们将在每次重启时传递。

## Dev 配置文件 + dev Gateway 网关（--dev）

使用 dev 配置文件来隔离状态，并启动一个安全、可丢弃的调试设置。有**两个** `--dev` 标志：

- **全局 `--dev`（配置文件）：** 将状态隔离到 `~/.openclaw-dev` 下，并将 Gateway 网关端口默认为 `19001`（派生端口随之移动）。
- **`gateway --dev`：告诉 Gateway 网关在缺失时自动创建默认配置 + 工作区**（并跳过 BOOTSTRAP.md）。

推荐流程（dev 配置文件 + dev 引导）：

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

如果你还没有全局安装，请通过 `pnpm openclaw ...` 运行 CLI。

这会执行：

1. **配置文件隔离**（全局 `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001`（浏览器/画布相应移动）

2. **Dev 引导**（`gateway --dev`）
   - 如果缺失则写入最小配置（`gateway.mode=local`，绑定 loopback）。
   - 将 `agent.workspace` 设置为 dev 工作区。
   - 设置 `agent.skipBootstrap=true`（无 BOOTSTRAP.md）。
   - 如果缺失则填充工作区文件：
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - 默认身份：**C3‑PO**（礼仪机器人）。
   - 在 dev 模式下跳过渠道提供商（`OPENCLAW_SKIP_CHANNELS=1`）。

重置流程（全新开始）：

```bash
pnpm gateway:dev:reset
```

注意：`--dev` 是**全局**配置文件标志，会被某些运行器吞掉。
如果你需要明确拼写，请使用环境变量形式：

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 清除配置、凭证、会话和 dev 工作区（使用 `trash`，而非 `rm`），然后重新创建默认的 dev 设置。

提示：如果非 dev Gateway 网关已在运行（launchd/systemd），请先停止它：

```bash
openclaw gateway stop
```

## 原始流日志（OpenClaw）

OpenClaw 可以在任何过滤/格式化之前记录**原始助手流**。
这是查看推理是否作为纯文本增量到达（或作为单独的思考块）的最佳方式。

通过 CLI 启用：

```bash
pnpm gateway:watch --force --raw-stream
```

可选路径覆盖：

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

等效环境变量：

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

默认文件：

`~/.openclaw/logs/raw-stream.jsonl`

## 原始块日志（pi-mono）

要在解析为块之前捕获**原始 OpenAI 兼容块**，pi-mono 暴露了一个单独的日志记录器：

```bash
PI_RAW_STREAM=1
```

可选路径：

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

默认文件：

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意：这仅由使用 pi-mono 的 `openai-completions` 提供商的进程发出。

## 安全注意事项

- 原始流日志可能包含完整提示、工具输出和用户数据。
- 保持日志在本地并在调试后删除它们。
- 如果你分享日志，请先清除密钥和个人身份信息。
