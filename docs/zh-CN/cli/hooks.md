---
read_when:
  - 你想管理智能体钩子
  - 你想安装或更新钩子
summary: CLI 参考：`openclaw hooks`（智能体钩子）
title: hooks
x-i18n:
  generated_at: "2026-02-03T10:04:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e2032e61ff4b9135cb2708d92eb7889ac627b85a5fc153e3d5b84265f7bd7bc6
  source_path: cli/hooks.md
  workflow: 15
---

# `openclaw hooks`

管理智能体钩子（针对 `/new`、`/reset` 等命令以及 Gateway 网关启动的事件驱动自动化）。

相关内容：

- 钩子：[钩子](/automation/hooks)
- 插件钩子：[插件](/tools/plugin#plugin-hooks)

## 列出所有钩子

```bash
openclaw hooks list
```

列出从工作区、托管目录和内置目录中发现的所有钩子。

**选项：**

- `--eligible`：仅显示符合条件的钩子（满足要求）
- `--json`：以 JSON 格式输出
- `-v, --verbose`：显示详细信息，包括缺失的要求

**示例输出：**

```
Hooks (3/3 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
```

**示例（详细模式）：**

```bash
openclaw hooks list --verbose
```

显示不符合条件的钩子缺失的要求。

**示例（JSON）：**

```bash
openclaw hooks list --json
```

返回结构化 JSON，供程序化使用。

## 获取钩子信息

```bash
openclaw hooks info <name>
```

显示特定钩子的详细信息。

**参数：**

- `<name>`：钩子名称（例如 `session-memory`）

**选项：**

- `--json`：以 JSON 格式输出

**示例：**

```bash
openclaw hooks info session-memory
```

**输出：**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/automation/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## 检查钩子资格

```bash
openclaw hooks check
```

显示钩子资格状态摘要（有多少已就绪，有多少未就绪）。

**选项：**

- `--json`：以 JSON 格式输出

**示例输出：**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## 启用钩子

```bash
openclaw hooks enable <name>
```

通过将特定钩子添加到配置（`~/.openclaw/openclaw.json`）来启用它。

**注意：** 由插件管理的钩子在 `openclaw hooks list` 中显示 `plugin:<id>`，
无法在此处启用/禁用。请改为启用/禁用该插件。

**参数：**

- `<name>`：钩子名称（例如 `session-memory`）

**示例：**

```bash
openclaw hooks enable session-memory
```

**输出：**

```
✓ Enabled hook: 💾 session-memory
```

**执行操作：**

- 检查钩子是否存在且符合条件
- 在配置中更新 `hooks.internal.entries.<name>.enabled = true`
- 将配置保存到磁盘

**启用后：**

- 重启 Gateway 网关以重新加载钩子（macOS 上重启菜单栏应用，或在开发环境中重启 Gateway 网关进程）。

## 禁用钩子

```bash
openclaw hooks disable <name>
```

通过更新配置来禁用特定钩子。

**参数：**

- `<name>`：钩子名称（例如 `command-logger`）

**示例：**

```bash
openclaw hooks disable command-logger
```

**输出：**

```
⏸ Disabled hook: 📝 command-logger
```

**禁用后：**

- 重启 Gateway 网关以重新加载钩子

## 安装钩子

```bash
openclaw hooks install <path-or-spec>
```

从本地文件夹/压缩包或 npm 安装钩子包。

**执行操作：**

- 将钩子包复制到 `~/.openclaw/hooks/<id>`
- 在 `hooks.internal.entries.*` 中启用已安装的钩子
- 在 `hooks.internal.installs` 下记录安装信息

**选项：**

- `-l, --link`：链接本地目录而不是复制（将其添加到 `hooks.internal.load.extraDirs`）

**支持的压缩包格式：** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**示例：**

```bash
# 本地目录
openclaw hooks install ./my-hook-pack

# 本地压缩包
openclaw hooks install ./my-hook-pack.zip

# NPM 包
openclaw hooks install @openclaw/my-hook-pack

# 链接本地目录而不复制
openclaw hooks install -l ./my-hook-pack
```

## 更新钩子

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

更新已安装的钩子包（仅限 npm 安装）。

**选项：**

- `--all`：更新所有已跟踪的钩子包
- `--dry-run`：显示将要进行的更改，但不写入

## 内置钩子

### session-memory

在你执行 `/new` 时将会话上下文保存到记忆中。

**启用：**

```bash
openclaw hooks enable session-memory
```

**输出：** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**参见：** [session-memory 文档](/automation/hooks#session-memory)

### command-logger

将所有命令事件记录到集中的审计文件中。

**启用：**

```bash
openclaw hooks enable command-logger
```

**输出：** `~/.openclaw/logs/commands.log`

**查看日志：**

```bash
# 最近的命令
tail -n 20 ~/.openclaw/logs/commands.log

# 格式化输出
cat ~/.openclaw/logs/commands.log | jq .

# 按操作过滤
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**参见：** [command-logger 文档](/automation/hooks#command-logger)

### boot-md

在 Gateway 网关启动时（渠道启动后）运行 `BOOT.md`。

**事件**：`gateway:startup`

**启用**：

```bash
openclaw hooks enable boot-md
```

**参见：** [boot-md 文档](/automation/hooks#boot-md)
