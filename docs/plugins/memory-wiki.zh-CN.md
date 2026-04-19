---
summary: "memory-wiki: 具有来源、声明、仪表板和桥接模式的编译知识库"
read_when:
  - 你想要超越普通 MEMORY.md 笔记的持久知识
  - 你正在配置捆绑的 memory-wiki 插件
  - 你想了解 wiki_search、wiki_get 或桥接模式
title: "内存维基"
---

# 内存维基

`memory-wiki` 是一个捆绑插件，将持久内存转变为编译的知识库。

它**不会**替换活动内存插件。活动内存插件仍然负责回忆、提升、索引和做梦。`memory-wiki` 位于其旁边，将持久知识编译成具有确定性页面、结构化声明、来源、仪表板和机器可读摘要的可导航维基。

当你希望内存表现得更像一个维护的知识层，而不是一堆 Markdown 文件时使用它。

## 它添加了什么

- 具有确定性页面布局的专用维基库
- 结构化声明和证据元数据，而不仅仅是散文
- 页面级来源、置信度、矛盾和开放问题
- 为代理/运行时消费者编译的摘要
- 维基原生的搜索/获取/应用/ lint 工具
- 可选的桥接模式，从活动内存插件导入公共 artifact
- 可选的 Obsidian 友好渲染模式和 CLI 集成

## 它如何与内存配合

可以这样考虑这种分工：

| 层                                            | 负责                                                             |
| --------------------------------------------- | ---------------------------------------------------------------- |
| 活动内存插件（`memory-core`、QMD、Honcho 等） | 回忆、语义搜索、提升、做梦、内存运行时                           |
| `memory-wiki`                                 | 编译的维基页面、富含来源的综合、仪表板、维基特定的搜索/获取/应用 |

如果活动内存插件公开共享的回忆 artifact，OpenClaw 可以通过 `memory_search corpus=all` 一次搜索两个层。

当你需要维基特定的排名、来源或直接页面访问时，请改用维基原生工具。

## 推荐的混合模式

本地优先设置的强大默认值是：

- QMD 作为活动内存后端，用于回忆和广泛的语义搜索
- `memory-wiki` 在 `bridge` 模式下用于持久的综合知识页面

这种分工效果很好，因为每一层都保持专注：

- QMD 保持原始笔记、会话导出和额外集合可搜索
- `memory-wiki` 编译稳定的实体、声明、仪表板和源页面

实用规则：

- 当你想要一次广泛的内存回忆时，使用 `memory_search`
- 当你想要了解来源的维基结果时，使用 `wiki_search` 和 `wiki_get`
- 当你想要共享搜索跨越两个层时，使用 `memory_search corpus=all`

如果桥接模式报告零导出 artifact，则活动内存插件当前尚未公开公共桥接输入。首先运行 `openclaw wiki doctor`，然后确认活动内存插件支持公共 artifact。

## 库模式

`memory-wiki` 支持三种库模式：

### `isolated`

自己的库，自己的源，不依赖 `memory-core`。

当你希望维基成为自己的策划知识存储时使用此模式。

### `bridge`

通过公共插件 SDK 接口从活动内存插件读取公共内存 artifact 和内存事件。

当你希望维基编译和组织内存插件的导出 artifact，而不涉及私有插件内部时使用此模式。

桥接模式可以索引：

- 导出的内存 artifact
- 梦报告
- 每日笔记
- 内存根文件
- 内存事件日志

### `unsafe-local`

用于本地私有路径的显式同机逃生通道。

此模式是有意实验性的且不可移植的。仅当你了解信任边界并特别需要桥接模式无法提供的本地文件系统访问时才使用它。

## 库布局

插件像这样初始化一个库：

```text
<vault>/
  AGENTS.md
  WIKI.md
  index.md
  inbox.md
  entities/
  concepts/
  syntheses/
  sources/
  reports/
  _attachments/
  _views/
  .openclaw-wiki/
```

管理的内容保留在生成的块中。人类笔记块被保留。

主要页面组是：

- `sources/` 用于导入的原材料和桥接支持的页面
- `entities/` 用于持久的事物、人、系统、项目和对象
- `concepts/` 用于想法、抽象、模式和策略
- `syntheses/` 用于编译的摘要和维护的汇总
- `reports/` 用于生成的仪表板

## 结构化声明和证据

页面可以携带结构化的 `claims` 前置元数据，而不仅仅是自由格式文本。

每个声明可以包括：

- `id`
- `text`
- `status`
- `confidence`
- `evidence[]`
- `updatedAt`

证据条目可以包括：

- `sourceId`
- `path`
- `lines`
- `weight`
- `note`
- `updatedAt`

这就是使维基更像是一个信念层而不是被动笔记转储的原因。声明可以被跟踪、评分、质疑并解决回源。

## 编译管道

编译步骤读取维基页面，规范化摘要，并在以下位置发出稳定的面向机器的 artifact：

- `.openclaw-wiki/cache/agent-digest.json`
- `.openclaw-wiki/cache/claims.jsonl`

这些摘要的存在是为了让代理和运行时代码不必抓取 Markdown 页面。

编译输出还支持：

- 用于搜索/获取流程的首次通过维基索引
- 声明 ID 查找回所属页面
- 紧凑的提示补充
- 报告/仪表板生成

## 仪表板和健康报告

当 `render.createDashboards` 启用时，编译在 `reports/` 下维护仪表板。

内置报告包括：

- `reports/open-questions.md`
- `reports/contradictions.md`
- `reports/low-confidence.md`
- `reports/claim-health.md`
- `reports/stale-pages.md`

这些报告跟踪以下内容：

- 矛盾笔记集群
- 竞争声明集群
- 缺少结构化证据的声明
- 低置信度页面和声明
- 陈旧或未知的新鲜度
- 有未解决问题的页面

## 搜索和检索

`memory-wiki` 支持两种搜索后端：

- `shared`：在可用时使用共享内存搜索流程
- `local`：在本地搜索维基

它还支持三个语料库：

- `wiki`
- `memory`
- `all`

重要行为：

- `wiki_search` 和 `wiki_get` 在可能的情况下使用编译摘要作为首次通过
- 声明 ID 可以解析回所属页面
- 有争议/陈旧/新鲜的声明会影响排名
- 来源标签可以存在于结果中

实用规则：

- 使用 `memory_search corpus=all` 进行一次广泛的回忆
- 当你关心维基特定的排名、来源或页面级信念结构时，使用 `wiki_search` + `wiki_get`

## 代理工具

插件注册这些工具：

- `wiki_status`
- `wiki_search`
- `wiki_get`
- `wiki_apply`
- `wiki_lint`

它们的作用：

- `wiki_status`：当前库模式、健康状态、Obsidian CLI 可用性
- `wiki_search`：搜索维基页面，并在配置时搜索共享内存语料库
- `wiki_get`：通过 ID/路径读取维基页面，或回退到共享内存语料库
- `wiki_apply`：窄范围的综合/元数据变更，无需自由形式的页面手术
- `wiki_lint`：结构检查、来源差距、矛盾、开放问题

插件还注册了一个非独占的内存语料库补充，因此当活动内存插件支持语料库选择时，共享的 `memory_search` 和 `memory_get` 可以访问维基。

## 提示和上下文行为

当 `context.includeCompiledDigestPrompt` 启用时，内存提示部分会追加来自 `agent-digest.json` 的紧凑编译快照。

该快照有意小而高信号：

- 仅顶级页面
- 仅顶级声明
- 矛盾计数
- 问题计数
- 置信度/新鲜度限定符

这是可选的，因为它会改变提示形状，并且主要对显式消耗内存补充的上下文引擎或传统提示组装有用。

## 配置

将配置放在 `plugins.entries.memory-wiki.config` 下：

```json5
{
  plugins: {
    entries: {
      "memory-wiki": {
        enabled: true,
        config: {
          vaultMode: "isolated",
          vault: {
            path: "~/.openclaw/wiki/main",
            renderMode: "obsidian",
          },
          obsidian: {
            enabled: true,
            useOfficialCli: true,
            vaultName: "OpenClaw Wiki",
            openAfterWrites: false,
          },
          bridge: {
            enabled: false,
            readMemoryArtifacts: true,
            indexDreamReports: true,
            indexDailyNotes: true,
            indexMemoryRoot: true,
            followMemoryEvents: true,
          },
          ingest: {
            autoCompile: true,
            maxConcurrentJobs: 1,
            allowUrlIngest: true,
          },
          search: {
            backend: "shared",
            corpus: "wiki",
          },
          context: {
            includeCompiledDigestPrompt: false,
          },
          render: {
            preserveHumanBlocks: true,
            createBacklinks: true,
            createDashboards: true,
          },
        },
      },
    },
  },
}
```

关键切换：

- `vaultMode`：`isolated`、`bridge`、`unsafe-local`
- `vault.renderMode`：`native` 或 `obsidian`
- `bridge.readMemoryArtifacts`：导入活动内存插件公共 artifact
- `bridge.followMemoryEvents`：在桥接模式下包含事件日志
- `search.backend`：`shared` 或 `local`
- `search.corpus`：`wiki`、`memory` 或 `all`
- `context.includeCompiledDigestPrompt`：将紧凑摘要快照附加到内存提示部分
- `render.createBacklinks`：生成确定性相关块
- `render.createDashboards`：生成仪表板页面

### 示例：QMD + 桥接模式

当你想要 QMD 用于回忆和 `memory-wiki` 用于维护的知识层时使用此模式：

```json5
{
  memory: {
    backend: "qmd",
      "memory-wiki": {
        enabled: true,
        config: {
          vaultMode: "bridge",
          bridge: {
            enabled: true,
            readMemoryArtifacts: true,
            indexDreamReports: true,
            indexDailyNotes: true,
            indexMemoryRoot: true,
            followMemoryEvents: true,
          },
          search: {
            backend: "shared",
            corpus: "all",
          },
          context: {
            includeCompiledDigestPrompt: false,
          },
        },
      },
    },
  },
}
```

这保持：

- QMD 负责活动内存回忆
- `memory-wiki` 专注于编译的页面和仪表板
- 提示形状不变，直到你有意启用编译摘要提示

## CLI

`memory-wiki` 还公开了顶级 CLI 界面：

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki compile
openclaw wiki lint
openclaw wiki search "alpha"
openclaw wiki get entity.alpha
openclaw wiki apply synthesis "Alpha Summary" --body "..." --source-id source.alpha
openclaw wiki bridge import
openclaw wiki obsidian status
```

有关完整的命令参考，请参阅 [CLI: wiki](/cli/wiki)。

## Obsidian 支持

当 `vault.renderMode` 为 `obsidian` 时，插件会写入 Obsidian 友好的 Markdown，并可选择使用官方的 `obsidian` CLI。

支持的工作流包括：

- 状态探测
- 库搜索
- 打开页面
- 调用 Obsidian 命令
- 跳转到每日笔记

这是可选的。维基在没有 Obsidian 的情况下仍可在原生模式下工作。

## 推荐工作流

1. 保留你的活动内存插件用于回忆/提升/做梦。
2. 启用 `memory-wiki`。
3. 从 `isolated` 模式开始，除非你明确想要桥接模式。
4. 当来源很重要时，使用 `wiki_search` / `wiki_get`。
5. 使用 `wiki_apply` 进行窄范围的综合或元数据更新。
6. 在有意义的更改后运行 `wiki_lint`。
7. 如果你想要查看陈旧/矛盾，请打开仪表板。

## 相关文档

- [内存概述](/concepts/memory)
- [CLI: memory](/cli/memory)
- [CLI: wiki](/cli/wiki)
- [插件 SDK 概述](/plugins/sdk-overview)
