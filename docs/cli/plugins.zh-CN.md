---
summary: "`openclaw plugins` 命令行参考（列出、安装、市场、卸载、启用/禁用、诊断）"
read_when:
  - 你想安装或管理网关插件或兼容包
  - 你想调试插件加载失败
title: "plugins"
---

# `openclaw plugins`

管理网关插件/扩展、钩子包和兼容包。

相关：

- 插件系统：[插件](/tools/plugin)
- 包兼容性：[插件包](/plugins/bundles)
- 插件清单 + 架构：[插件清单](/plugins/manifest)
- 安全加固：[安全](/gateway/security)

## 命令

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
openclaw plugins install <path-or-spec>
openclaw plugins inspect <id>
openclaw plugins inspect <id> --json
openclaw plugins inspect --all
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins marketplace list <marketplace>
openclaw plugins marketplace list <marketplace> --json
```

捆绑插件随 OpenClaw 一起提供。有些默认启用（例如捆绑的模型提供商、捆绑的语音提供商和捆绑的浏览器插件）；其他需要 `plugins enable`。

原生 OpenClaw 插件必须附带 `openclaw.plugin.json` 以及内联 JSON Schema（`configSchema`，即使为空）。兼容包使用自己的包清单代替。

`plugins list` 显示 `Format: openclaw` 或 `Format: bundle`。详细列表/信息输出还显示包子类型（`codex`、`claude` 或 `cursor`）以及检测到的包功能。

### 安装

```bash
openclaw plugins install <package>                      # 首先检查 ClawHub，然后 npm
openclaw plugins install clawhub:<package>              # 仅 ClawHub
openclaw plugins install <package> --force              # 覆盖现有安装
openclaw plugins install <package> --pin                # 固定版本
openclaw plugins install <package> --dangerously-force-unsafe-install
openclaw plugins install <path>                         # 本地路径
openclaw plugins install <plugin>@<marketplace>         # 市场
openclaw plugins install <plugin> --marketplace <name>  # 市场（显式）
openclaw plugins install <plugin> --marketplace https://github.com/<owner>/<repo>
```

裸包名首先在 ClawHub 中检查，然后在 npm 中检查。安全注意：将插件安装视为运行代码。首选固定版本。

如果配置无效，`plugins install` 通常会失败并告诉你先运行 `openclaw doctor --fix`。唯一有文档记录的例外是插件的狭窄捆绑插件恢复路径，这些插件明确选择加入 `openclaw.install.allowInvalidConfigRecovery`。

`--force` 重用现有安装目标并覆盖已安装的插件或钩子包。当你有意从新的本地路径、存档、ClawHub 包或 npm 工件重新安装相同 ID 时使用它。

`--pin` 仅适用于 npm 安装。它不支持 `--marketplace`，因为市场安装会保留市场源元数据而不是 npm 规范。

`--dangerously-force-unsafe-install` 是内置危险代码扫描中误报的紧急选项。它允许安装继续，即使内置扫描报告 `critical` 发现，但它**不会**绕过插件 `before_install` 钩子策略阻止，也**不会**绕过扫描失败。

此 CLI 标志适用于插件安装/更新流程。网关支持的技能依赖安装使用匹配的 `dangerouslyForceUnsafeInstall` 请求覆盖，而 `openclaw skills install` 仍然是单独的 ClawHub 技能下载/安装流程。

`plugins install` 也是在 `package.json` 中暴露 `openclaw.hooks` 的钩子包的安装界面。使用 `openclaw hooks` 进行过滤的钩子可见性和每个钩子的启用，而不是包安装。

Npm 规范**仅注册表**（包名称 + 可选**精确版本**或**分发标签**）。Git/URL/文件规范和 semver 范围被拒绝。依赖安装以 `--ignore-scripts` 运行以确保安全。

裸规范和 `@latest` 保持在稳定轨道上。如果 npm 将其中任何一个解析为预发布版本，OpenClaw 会停止并要求你使用预发布标签（如 `@beta`/`@rc`）或精确的预发布版本（如 `@1.2.3-beta.4`）明确选择加入。

如果裸安装规范与捆绑插件 ID 匹配（例如 `diffs`），OpenClaw 会直接安装捆绑插件。要安装同名的 npm 包，请使用显式作用域规范（例如 `@scope/diffs`）。

支持的存档：`.zip`、`.tgz`、`.tar.gz`、`.tar`。

也支持 Claude 市场安装。

ClawHub 安装使用显式 `clawhub:<package>` 定位器：

```bash
openclaw plugins install clawhub:openclaw-codex-app-server
openclaw plugins install clawhub:openclaw-codex-app-server@1.2.3
```

OpenClaw 现在也首选 ClawHub 用于裸 npm 安全插件规范。只有当 ClawHub 没有该包或版本时，它才会回退到 npm：

```bash
openclaw plugins install openclaw-codex-app-server
```

OpenClaw 从 ClawHub 下载包存档，检查广告的插件 API / 最小网关兼容性，然后通过正常的存档路径安装它。记录的安装保留其 ClawHub 源元数据以供以后更新。

当市场名称存在于 Claude 的本地注册表缓存 `~/.claude/plugins/known_marketplaces.json` 中时，使用 `plugin@marketplace` 简写：

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

当你想显式传递市场源时使用 `--marketplace`：

```bash
openclaw plugins install <plugin-name> --marketplace <marketplace-name>
openclaw plugins install <plugin-name> --marketplace <owner/repo>
openclaw plugins install <plugin-name> --marketplace https://github.com/<owner>/<repo>
openclaw plugins install <plugin-name> --marketplace ./my-marketplace
```

市场源可以是：

- 来自 `~/.claude/plugins/known_marketplaces.json` 的 Claude 已知市场名称
- 本地市场根目录或 `marketplace.json` 路径
- GitHub 仓库简写，如 `owner/repo`
- GitHub 仓库 URL，如 `https://github.com/owner/repo`
- git URL

对于从 GitHub 或 git 加载的远程市场，插件条目必须保留在克隆的市场仓库内。OpenClaw 接受来自该仓库的相对路径源，并拒绝远程清单中的 HTTP(S)、绝对路径、git、GitHub 和其他非路径插件源。

对于本地路径和存档，OpenClaw 自动检测：

- 原生 OpenClaw 插件（`openclaw.plugin.json`）
- Codex 兼容包（`.codex-plugin/plugin.json`）
- Claude 兼容包（`.claude-plugin/plugin.json` 或默认 Claude 组件布局）
- Cursor 兼容包（`.cursor-plugin/plugin.json`）

兼容包安装到正常的扩展根目录并参与相同的列表/信息/启用/禁用流程。今天，包技能、Claude 命令技能、Claude `settings.json` 默认值、Claude `.lsp.json` / 清单声明的 `lspServers` 默认值、Cursor 命令技能和兼容的 Codex 钩子目录都受支持；其他检测到的包功能显示在诊断/信息中，但尚未连接到运行时执行。

### 列表

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
```

使用 `--enabled` 仅显示已加载的插件。使用 `--verbose` 从表格视图切换到带有源/来源/版本/激活元数据的每个插件详细行。使用 `--json` 进行机器可读清单和注册表诊断。

使用 `--link` 避免复制本地目录（添加到 `plugins.load.paths`）：

```bash
openclaw plugins install -l ./my-plugin
```

`--force` 不支持 `--link`，因为链接安装重用源路径而不是复制到托管安装目标。

在 npm 安装上使用 `--pin` 将解析的精确规范（`name@version`）保存在 `plugins.installs` 中，同时保持默认行为为非固定。

### 卸载

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` 从 `plugins.entries`、`plugins.installs`、插件允许列表和适用时的链接 `plugins.load.paths` 条目中删除插件记录。对于活动内存插件，内存槽重置为 `memory-core`。

默认情况下，卸载还会删除活动状态目录插件根目录下的插件安装目录。使用
`--keep-files` 保留磁盘上的文件。

`--keep-config` 作为 `--keep-files` 的已弃用别名被支持。

### 更新

```bash
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins update <id-or-npm-spec> --dry-run
openclaw plugins update @openclaw/voice-call@beta
openclaw plugins update openclaw-codex-app-server --dangerously-force-unsafe-install
```

更新适用于 `plugins.installs` 中的跟踪安装和 `hooks.internal.installs` 中的跟踪钩子包安装。

当你传递插件 ID 时，OpenClaw 重用该插件的记录安装规范。这意味着以前存储的分发标签（如 `@beta`）和精确固定版本在以后的 `update <id>` 运行中继续使用。

对于 npm 安装，你还可以传递带有分发标签或精确版本的显式 npm 包规范。OpenClaw 将该包名称解析回跟踪的插件记录，更新该安装的插件，并记录新的 npm 规范以供将来基于 ID 的更新。

当存在存储的完整性哈希且获取的工件哈希发生变化时，OpenClaw 会打印警告并在继续之前请求确认。在 CI/非交互式运行中使用全局 `--yes` 绕过提示。

`--dangerously-force-unsafe-install` 在 `plugins update` 上也可用，作为插件更新期间内置危险代码扫描误报的紧急覆盖。它仍然不会绕过插件 `before_install` 策略阻止或扫描失败阻止，并且仅适用于插件更新，不适用于钩子包更新。

### 检查

```bash
openclaw plugins inspect <id>
openclaw plugins inspect <id> --json
```

单个插件的深度 introspection。显示身份、加载状态、源、注册的功能、钩子、工具、命令、服务、网关方法、HTTP 路由、策略标志、诊断、安装元数据、包功能以及任何检测到的 MCP 或 LSP 服务器支持。

每个插件根据其在运行时实际注册的内容进行分类：

- **plain-capability** — 一种功能类型（例如仅提供商插件）
- **hybrid-capability** — 多种功能类型（例如文本 + 语音 + 图像）
- **hook-only** — 仅钩子，无功能或表面
- **non-capability** — 工具/命令/服务但无功能

有关功能模型的更多信息，请参阅 [插件形状](/plugins/architecture#plugin-shapes)。

`--json` 标志输出适合脚本和审计的机器可读报告。

`inspect --all` 渲染一个全舰队表格，包含形状、功能种类、兼容性通知、包功能和钩子摘要列。

`info` 是 `inspect` 的别名。

### 诊断

```bash
openclaw plugins doctor
```

`doctor` 报告插件加载错误、清单/发现诊断和兼容性通知。当一切干净时，它会打印 `No plugin issues detected.`

### 市场

```bash
openclaw plugins marketplace list <source>
openclaw plugins marketplace list <source> --json
```

市场列表接受本地市场路径、`marketplace.json` 路径、GitHub 简写（如 `owner/repo`）、GitHub 仓库 URL 或 git URL。`--json` 打印解析的源标签以及解析的市场清单和插件条目。