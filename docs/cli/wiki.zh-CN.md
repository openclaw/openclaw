---
summary: "`openclaw wiki` 的 CLI 参考（memory-wiki 库状态、搜索、编译、lint、应用、桥接和 Obsidian 助手）"
read_when:
  - 你想使用 memory-wiki CLI
  - 你正在记录或更改 `openclaw wiki`
title: "wiki"
---

# `openclaw wiki`

检查和维护 `memory-wiki` 库。

由捆绑的 `memory-wiki` 插件提供。

相关：

- [内存维基插件](/plugins/memory-wiki)
- [内存概述](/concepts/memory)
- [CLI: memory](/cli/memory)

## 用途

当你想要一个具有以下功能的编译知识库时，使用 `openclaw wiki`：

- 维基原生搜索和页面读取
- 富含来源的综合
- 矛盾和新鲜度报告
- 从活动内存插件导入桥接
- 可选的 Obsidian CLI 助手

## 常用命令

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki compile
openclaw wiki lint
openclaw wiki search "alpha"
openclaw wiki get entity.alpha --from 1 --lines 80

openclaw wiki apply synthesis "Alpha Summary" \
  --body "Short synthesis body" \
  --source-id source.alpha

openclaw wiki apply metadata entity.alpha \
  --source-id source.alpha \
  --status review \
  --question "Still active?"

openclaw wiki bridge import
openclaw wiki unsafe-local import

openclaw wiki obsidian status
openclaw wiki obsidian search "alpha"
openclaw wiki obsidian open syntheses/alpha-summary.md
openclaw wiki obsidian command workspace:quick-switcher
openclaw wiki obsidian daily
```

## 命令

### `wiki status`

检查当前库模式、健康状态和 Obsidian CLI 可用性。

当你不确定库是否初始化、桥接模式是否健康或 Obsidian 集成是否可用时，首先使用此命令。

### `wiki doctor`

运行维基健康检查并显示配置或库问题。

典型问题包括：

- 启用了桥接模式但没有公共内存 artifact
- 无效或缺失的库布局
- 当期望 Obsidian 模式时缺少外部 Obsidian CLI

### `wiki init`

创建维基库布局和起始页面。

这会初始化根结构，包括顶级索引和缓存目录。

### `wiki ingest <path-or-url>`

将内容导入维基源层。

注意：

- URL 摄取由 `ingest.allowUrlIngest` 控制
- 导入的源页面在前置元数据中保留来源
- 启用时，自动编译可以在摄取后运行

### `wiki compile`

重建索引、相关块、仪表板和编译摘要。

这会在以下位置写入稳定的面向机器的 artifact：

- `.openclaw-wiki/cache/agent-digest.json`
- `.openclaw-wiki/cache/claims.jsonl`

如果启用了 `render.createDashboards`，编译还会刷新报告页面。

### `wiki lint`

检查库并报告：

- 结构问题
- 来源差距
- 矛盾
- 开放问题
- 低置信度页面/声明
- 陈旧页面/声明

在有意义的维基更新后运行此命令。

### `wiki search <query>`

搜索维基内容。

行为取决于配置：

- `search.backend`：`shared` 或 `local`
- `search.corpus`：`wiki`、`memory` 或 `all`

当你想要维基特定的排名或来源详细信息时，使用 `wiki search`。
对于一次广泛的共享回忆，当活动内存插件公开共享搜索时，首选 `openclaw memory search`。

### `wiki get <lookup>`

通过 ID 或相对路径读取维基页面。

示例：

```bash
openclaw wiki get entity.alpha
openclaw wiki get syntheses/alpha-summary.md --from 1 --lines 80
```

### `wiki apply`

应用窄范围的变更，无需自由形式的页面手术。

支持的流程包括：

- 创建/更新综合页面
- 更新页面元数据
- 附加源 ID
- 添加问题
- 添加矛盾
- 更新置信度/状态
- 写入结构化声明

此命令的存在是为了让维基可以安全地演变，而无需手动编辑管理的块。

### `wiki bridge import`

将活动内存插件的公共内存 artifact 导入桥接支持的源页面。

在 `bridge` 模式下，当你想要将最新的导出内存 artifact 拉入维基库时使用此命令。

### `wiki unsafe-local import`

在 `unsafe-local` 模式下从明确配置的本地路径导入。

这是有意实验性的，仅适用于同一机器。

### `wiki obsidian ...`

在 Obsidian 友好模式下运行的库的 Obsidian 助手命令。

子命令：

- `status`
- `search`
- `open`
- `command`
- `daily`

当 `obsidian.useOfficialCli` 启用时，这些需要 `PATH` 上的官方 `obsidian` CLI。

## 实用使用指南

- 当来源和页面标识重要时，使用 `wiki search` + `wiki get`。
- 使用 `wiki apply` 而不是手动编辑管理的生成部分。
- 在信任矛盾或低置信度内容之前使用 `wiki lint`。
- 当你希望立即获得新鲜的仪表板和编译摘要时，在批量导入或源更改后使用 `wiki compile`。
- 当桥接模式依赖于新导出的内存 artifact 时，使用 `wiki bridge import`。

## 配置关联

`openclaw wiki` 行为由以下因素决定：

- `plugins.entries.memory-wiki.config.vaultMode`
- `plugins.entries.memory-wiki.config.search.backend`
- `plugins.entries.memory-wiki.config.search.corpus`
- `plugins.entries.memory-wiki.config.bridge.*`
- `plugins.entries.memory-wiki.config.obsidian.*`
- `plugins.entries.memory-wiki.config.render.*`
- `plugins.entries.memory-wiki.config.context.includeCompiledDigestPrompt`

有关完整的配置模型，请参阅 [内存维基插件](/plugins/memory-wiki)。
