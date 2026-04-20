---
summary: "ClawHub 指南：公共注册表、原生 OpenClaw 安装流程和 ClawHub CLI 工作流"
read_when:
  - 向新用户介绍 ClawHub
  - 安装、搜索或发布技能或插件
  - 解释 ClawHub CLI 标志和同步行为
title: "ClawHub"
---

# ClawHub

ClawHub 是**OpenClaw 技能和插件**的公共注册表。

- 使用原生 `openclaw` 命令从 ClawHub 搜索/安装/更新技能和安装插件。
- 当你需要注册表身份验证、发布、删除、取消删除或同步工作流时，使用单独的 `clawhub` CLI。

网站：[clawhub.ai](https://clawhub.ai)

## 原生 OpenClaw 流程

技能：

```bash
openclaw skills search "calendar"
openclaw skills install <skill-slug>
openclaw skills update --all
```

插件：

```bash
openclaw plugins install clawhub:<package>
openclaw plugins update --all
```

裸 npm 安全插件规格也会在 npm 之前尝试 ClawHub：

```bash
openclaw plugins install openclaw-codex-app-server
```

原生 `openclaw` 命令安装到你的活动工作区并持久化源元数据，以便以后的 `update` 调用可以保持在 ClawHub 上。

插件安装在归档安装运行之前验证广告的 `pluginApi` 和 `minGatewayVersion` 兼容性，因此不兼容的主机早期关闭失败，而不是部分安装包。

`openclaw plugins install clawhub:...` 只接受可安装的插件家族。如果 ClawHub 包实际上是技能，OpenClaw 会停止并指向你使用 `openclaw skills install <slug>` 代替。

## ClawHub 是什么

- OpenClaw 技能和插件的公共注册表。
- 技能包和元数据的版本化存储。
- 搜索、标签和使用信号的发现表面。

## 它如何工作

1. 用户发布技能包（文件 + 元数据）。
2. ClawHub 存储包，解析元数据，并分配版本。
3. 注册表为搜索和发现索引技能。
4. 用户在 OpenClaw 中浏览、下载和安装技能。

## 你可以做什么

- 发布新技能和现有技能的新版本。
- 通过名称、标签或搜索发现技能。
- 下载技能包并检查其文件。
- 报告滥用或不安全的技能。
- 如果你是版主，可以隐藏、取消隐藏、删除或禁止。

## 这是为谁准备的（对初学者友好）

如果你想向你的 OpenClaw 代理添加新功能，ClawHub 是查找和安装技能的最简单方法。你不需要知道后端如何工作。你可以：

- 通过普通语言搜索技能。
- 将技能安装到你的工作区。
- 稍后用一个命令更新技能。
- 通过发布备份你自己的技能。

## 快速入门（非技术）

1. 搜索你需要的东西：
   - `openclaw skills search "calendar"`
2. 安装技能：
   - `openclaw skills install <skill-slug>`
3. 开始新的 OpenClaw 会话，以便它获取新技能。
4. 如果你想发布或管理注册表身份验证，也安装单独的 `clawhub` CLI。

## 安装 ClawHub CLI

你只需要这个用于注册表身份验证的工作流，如发布/同步：

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## 它如何融入 OpenClaw

原生 `openclaw skills install` 安装到活动工作区的 `skills/` 目录。`openclaw plugins install clawhub:...` 记录正常的托管插件安装加上 ClawHub 源元数据以进行更新。

匿名 ClawHub 插件安装对于私有包也会关闭失败。社区或其他非官方渠道仍然可以安装，但 OpenClaw 会警告，以便操作员可以在启用它们之前审查源代码和验证。

单独的 `clawhub` CLI 也将技能安装到当前工作目录下的 `./skills`。如果配置了 OpenClaw 工作区，`clawhub` 会回退到该工作区，除非你覆盖 `--workdir`（或 `CLAWHUB_WORKDIR`）。OpenClaw 从 `<workspace>/skills` 加载工作区技能，并将在**下一个**会话中获取它们。如果你已经使用 `~/.openclaw/skills` 或捆绑技能，工作区技能优先。

有关技能如何加载、共享和门控的更多详细信息，请参阅 [技能](/tools/skills)。

## 技能系统概述

技能是一个版本化的文件包，教 OpenClaw 如何执行特定任务。每次发布都会创建一个新版本，注册表会保留版本历史，以便用户可以审计更改。

典型的技能包括：

- 一个包含主要描述和用法的 `SKILL.md` 文件。
- 技能使用的可选配置、脚本或支持文件。
- 元数据，如标签、摘要和安装要求。

ClawHub 使用元数据来支持发现并安全地暴露技能能力。注册表还跟踪使用信号（如星标和下载）以改进排名和可见性。

## 服务提供什么（功能）

- 技能及其 `SKILL.md` 内容的**公共浏览**。
- 由嵌入（向量搜索）驱动的**搜索**，而不仅仅是关键字。
- 带有语义版本、变更日志和标签（包括 `latest`）的**版本控制**。
- 每个版本以 zip 形式**下载**。
- 用于社区反馈的**星标和评论**。
- 用于批准和审计的**审核**钩子。
- 用于自动化和脚本的**CLI 友好 API**。

## 安全和审核

ClawHub 默认开放。任何人都可以上传技能，但 GitHub 账户必须至少有一周的历史才能发布。这有助于减缓滥用，同时不阻止合法贡献者。

报告和审核：

- 任何登录用户都可以报告技能。
- 报告原因是必需的并被记录。
- 每个用户一次最多可以有 20 个活跃报告。
- 默认情况下，具有超过 3 个唯一报告的技能会自动隐藏。
- 版主可以查看隐藏的技能、取消隐藏它们、删除它们或禁止用户。
- 滥用报告功能可能导致账户被禁止。

有兴趣成为版主吗？在 OpenClaw Discord 中询问并联系版主或维护者。

## CLI 命令和参数

全局选项（适用于所有命令）：

- `--workdir <dir>`：工作目录（默认：当前目录；回退到 OpenClaw 工作区）。
- `--dir <dir>`：技能目录，相对于工作目录（默认：`skills`）。
- `--site <url>`：站点基础 URL（浏览器登录）。
- `--registry <url>`：注册表 API 基础 URL。
- `--no-input`：禁用提示（非交互式）。
- `-V, --cli-version`：打印 CLI 版本。

身份验证：

- `clawhub login`（浏览器流程）或 `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

选项：

- `--token <token>`：粘贴 API 令牌。
- `--label <label>`：为浏览器登录令牌存储的标签（默认：`CLI token`）。
- `--no-browser`：不打开浏览器（需要 `--token`）。

搜索：

- `clawhub search "query"`
- `--limit <n>`：最大结果数。

安装：

- `clawhub install <slug>`
- `--version <version>`：安装特定版本。
- `--force`：如果文件夹已存在，则覆盖。

更新：

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`：更新到特定版本（仅单个 slug）。
- `--force`：当本地文件与任何已发布版本不匹配时覆盖。

列出：

- `clawhub list`（读取 `.clawhub/lock.json`）

发布技能：

- `clawhub skill publish <path>`
- `--slug <slug>`：技能 slug。
- `--name <name>`：显示名称。
- `--version <version>`：语义版本。
- `--changelog <text>`：变更日志文本（可以为空）。
- `--tags <tags>`：逗号分隔的标签（默认：`latest`）。

发布插件：

- `clawhub package publish <source>`
- `<source>` 可以是本地文件夹、`owner/repo`、`owner/repo@ref` 或 GitHub URL。
- `--dry-run`：构建确切的发布计划而不上传任何内容。
- `--json`：为 CI 发出机器可读输出。
- `--source-repo`、`--source-commit`、`--source-ref`：当自动检测不足时的可选覆盖。

删除/取消删除（仅限所有者/管理员）：

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

同步（扫描本地技能 + 发布新/更新）：

- `clawhub sync`
- `--root <dir...>`：额外的扫描根目录。
- `--all`：无提示上传所有内容。
- `--dry-run`：显示将要上传的内容。
- `--bump <type>`：更新的 `patch|minor|major`（默认：`patch`）。
- `--changelog <text>`：非交互式更新的变更日志。
- `--tags <tags>`：逗号分隔的标签（默认：`latest`）。
- `--concurrency <n>`：注册表检查（默认：4）。

## 代理的常见工作流

### 搜索技能

```bash
clawhub search "postgres backups"
```

### 下载新技能

```bash
clawhub install my-skill-pack
```

### 更新已安装的技能

```bash
clawhub update --all
```

### 备份你的技能（发布或同步）

对于单个技能文件夹：

```bash
clawhub skill publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

一次扫描和备份多个技能：

```bash
clawhub sync --all
```

### 从 GitHub 发布插件

```bash
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
clawhub package publish your-org/your-plugin@v1.0.0
clawhub package publish https://github.com/your-org/your-plugin
```

代码插件必须在 `package.json` 中包含所需的 OpenClaw 元数据：

```json
{
  "name": "@myorg/openclaw-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./index.ts"],
    "compat": {
      "pluginApi": ">=2026.3.24-beta.2",
      "minGatewayVersion": "2026.3.24-beta.2"
    },
    "build": {
      "openclawVersion": "2026.3.24-beta.2",
      "pluginSdkVersion": "2026.3.24-beta.2"
    }
  }
}
```

## 高级详情（技术）

### 版本控制和标签

- 每次发布都会创建新的**语义版本** `SkillVersion`。
- 标签（如 `latest`）指向版本；移动标签让你可以回滚。
- 变更日志按版本附加，在同步或发布更新时可以为空。

### 本地更改与注册表版本

更新使用内容哈希比较本地技能内容与注册表版本。如果本地文件与任何已发布版本不匹配，CLI 会在覆盖之前询问（或在非交互式运行中需要 `--force`）。

### 同步扫描和回退根目录

`clawhub sync` 首先扫描你当前的工作目录。如果未找到技能，它会回退到已知的遗留位置（例如 `~/openclaw/skills` 和 `~/.openclaw/skills`）。这旨在无需额外标志即可找到较旧的技能安装。

### 存储和锁文件

- 已安装的技能记录在工作目录下的 `.clawhub/lock.json` 中。
- 身份验证令牌存储在 ClawHub CLI 配置文件中（通过 `CLAWHUB_CONFIG_PATH` 覆盖）。

### 遥测（安装计数）

当你在登录时运行 `clawhub sync` 时，CLI 发送一个最小快照来计算安装计数。你可以完全禁用此功能：

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## 环境变量

- `CLAWHUB_SITE`：覆盖站点 URL。
- `CLAWHUB_REGISTRY`：覆盖注册表 API URL。
- `CLAWHUB_CONFIG_PATH`：覆盖 CLI 存储令牌/配置的位置。
- `CLAWHUB_WORKDIR`：覆盖默认工作目录。
- `CLAWHUB_DISABLE_TELEMETRY=1`：禁用 `sync` 上的遥测。