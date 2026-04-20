---
summary: "`openclaw hooks`的CLI参考（代理钩子）"
read_when:
  - 您想管理代理钩子
  - 您想检查钩子可用性或启用工作区钩子
title: "hooks"
---

# `openclaw hooks`

管理代理钩子（事件驱动的自动化，用于`/new`、`/reset`和gateway启动等命令）。

不带子命令运行`openclaw hooks`等同于`openclaw hooks list`。

相关：

- 钩子：[Hooks](/automation/hooks)
- 插件钩子：[Plugin hooks](/plugins/architecture#provider-runtime-hooks)

## 列出所有钩子

```bash
openclaw hooks list
```

列出从工作区、管理、额外和捆绑目录中发现的所有钩子。

**选项：**

- `--eligible`: 仅显示符合条件的钩子（满足要求）
- `--json`: 以JSON输出
- `-v, --verbose`: 显示详细信息，包括缺失的要求

**示例输出：**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject extra workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new or /reset command is issued
```

**示例（详细）：**

```bash
openclaw hooks list --verbose
```

显示不符合条件的钩子的缺失要求。

**示例（JSON）：**

```bash
openclaw hooks list --json
```

返回结构化JSON以供编程使用。

## 获取钩子信息

```bash
openclaw hooks info <name>
```

显示有关特定钩子的详细信息。

**参数：**

- `<name>`: 钩子名称或钩子键（例如 `session-memory`）

**选项：**

- `--json`: 以JSON输出

**示例：**

```bash
openclaw hooks info session-memory
```

**输出：**

```
💾 session-memory ✓ Ready

Save session context to memory when /new or /reset command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/automation/hooks#session-memory
  Events: command:new, command:reset

Requirements:
  Config: ✓ workspace.dir
```

## 检查钩子资格

```bash
openclaw hooks check
```

显示钩子资格状态的摘要（有多少准备就绪与未准备就绪）。

**选项：**

- `--json`: 以JSON输出

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

通过将钩子添加到配置中来启用特定钩子（默认情况下为`~/.openclaw/openclaw.json`）。

**注意：** 工作区钩子默认是禁用的，直到在此处或配置中启用。由插件管理的钩子在`openclaw hooks list`中显示为`plugin:<id>`，不能在此处启用/禁用。而是启用/禁用插件。

**参数：**

- `<name>`: 钩子名称（例如 `session-memory`）

**示例：**

```bash
openclaw hooks enable session-memory
```

**输出：**

```
✓ Enabled hook: 💾 session-memory
```

**它的作用：**

- 检查钩子是否存在且符合条件
- 在配置中更新`hooks.internal.entries.<name>.enabled = true`
- 将配置保存到磁盘

如果钩子来自`<workspace>/hooks/`，则在Gateway加载它之前需要此选择加入步骤。

**启用后：**

- 重新启动gateway以便钩子重新加载（macOS上的菜单栏应用程序重启，或在开发中重启gateway进程）。

## 禁用钩子

```bash
openclaw hooks disable <name>
```

通过更新配置来禁用特定钩子。

**参数：**

- `<name>`: 钩子名称（例如 `command-logger`）

**示例：**

```bash
openclaw hooks disable command-logger
```

**输出：**

```
⏸ Disabled hook: 📝 command-logger
```

**禁用后：**

- 重新启动gateway以便钩子重新加载

## 注意事项

- `openclaw hooks list --json`、`info --json`和`check --json`直接将结构化JSON写入stdout。
- 插件管理的钩子不能在此处启用或禁用；而是启用或禁用拥有的插件。

## 安装钩子包

```bash
openclaw plugins install <package>        # ClawHub优先，然后是npm
openclaw plugins install <package> --pin  # 固定版本
openclaw plugins install <path>           # 本地路径
```

通过统一的插件安装程序安装钩子包。

`openclaw hooks install`仍然作为兼容性别名工作，但它会打印弃用警告并转发到`openclaw plugins install`。

Npm规范是**仅注册表**（包名 + 可选的**精确版本**或**分发标签**）。Git/URL/文件规范和semver范围被拒绝。依赖安装使用`--ignore-scripts`以确保安全。

裸规范和`@latest`保持在稳定轨道上。如果npm将其中任何一个解析为预发布版本，OpenClaw会停止并要求您使用预发布标签（如`@beta`/`@rc`）或精确的预发布版本明确选择加入。

**它的作用：**

- 将钩子包复制到`~/.openclaw/hooks/<id>`
- 在`hooks.internal.entries.*`中启用已安装的钩子
- 在`hooks.internal.installs`下记录安装

**选项：**

- `-l, --link`: 链接本地目录而不是复制（将其添加到`hooks.internal.load.extraDirs`）
- `--pin`: 将npm安装记录为`hooks.internal.installs`中的精确解析的`name@version`

**支持的存档：** `.zip`、`.tgz`、`.tar.gz`、`.tar`

**示例：**

```bash
# 本地目录
openclaw plugins install ./my-hook-pack

# 本地存档
openclaw plugins install ./my-hook-pack.zip

# NPM包
openclaw plugins install @openclaw/my-hook-pack

# 链接本地目录而不复制
openclaw plugins install -l ./my-hook-pack
```

链接的钩子包被视为来自操作员配置目录的管理钩子，而不是工作区钩子。

## 更新钩子包

```bash
openclaw plugins update <id>
openclaw plugins update --all
```

通过统一的插件更新程序更新跟踪的基于npm的钩子包。

`openclaw hooks update`仍然作为兼容性别名工作，但它会打印弃用警告并转发到`openclaw plugins update`。

**选项：**

- `--all`: 更新所有跟踪的钩子包
- `--dry-run`: 显示将更改的内容而不写入

当存在存储的完整性哈希并且获取的工件哈希发生变化时，OpenClaw会打印警告并在继续之前请求确认。在CI/非交互式运行中使用全局`--yes`绕过提示。

## 捆绑的钩子

### session-memory

当您发出`/new`或`/reset`时，将会话上下文保存到内存。

**启用：**

```bash
openclaw hooks enable session-memory
```

**输出：** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**查看：** [session-memory文档](/automation/hooks#session-memory)

### bootstrap-extra-files

在`agent:bootstrap`期间注入额外的引导文件（例如monorepo本地的`AGENTS.md` / `TOOLS.md`）。

**启用：**

```bash
openclaw hooks enable bootstrap-extra-files
```

**查看：** [bootstrap-extra-files文档](/automation/hooks#bootstrap-extra-files)

### command-logger

将所有命令事件记录到集中的审计文件。

**启用：**

```bash
openclaw hooks enable command-logger
```

**输出：** `~/.openclaw/logs/commands.log`

**查看日志：**

```bash
# 最近的命令
tail -n 20 ~/.openclaw/logs/commands.log

# 美化打印
cat ~/.openclaw/logs/commands.log | jq .

# 按操作过滤
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**查看：** [command-logger文档](/automation/hooks#command-logger)

### boot-md

在gateway启动时运行`BOOT.md`（通道启动后）。

**事件**：`gateway:startup`

**启用**：

```bash
openclaw hooks enable boot-md
```

**查看：** [boot-md文档](/automation/hooks#boot-md)