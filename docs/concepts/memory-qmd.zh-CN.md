---
title: "QMD 内存引擎"
summary: "本地优先的搜索侧车，具有 BM25、向量、重排序和查询扩展功能"
read_when:
  - 你想设置 QMD 作为内存后端
  - 你想要高级内存功能，如重排序或额外的索引路径
---

# QMD 内存引擎

[QMD](https://github.com/tobi/qmd) 是一个本地优先的搜索侧车，与 OpenClaw 一起运行。它在单个二进制文件中结合了 BM25、向量搜索和重排序，可以索引工作区内存文件之外的内容。

## 相比内置引擎的优势

- **重排序和查询扩展**，提供更好的回忆。
- **索引额外目录** —— 项目文档、团队笔记、磁盘上的任何内容。
- **索引会话记录** —— 回忆 earlier 对话。
- **完全本地** —— 通过 Bun + node-llama-cpp 运行，自动下载 GGUF 模型。
- **自动回退** —— 如果 QMD 不可用，OpenClaw 会无缝回退到内置引擎。

## 入门

### 先决条件

- 安装 QMD：`npm install -g @tobilu/qmd` 或 `bun install -g @tobilu/qmd`
- 允许扩展的 SQLite 构建（在 macOS 上 `brew install sqlite`）。
- QMD 必须在网关的 `PATH` 中。
- macOS 和 Linux 开箱即用。Windows 最好通过 WSL2 支持。

### 启用

```json5
{
  memory: {
    backend: "qmd",
  },
}
```

OpenClaw 在 `~/.openclaw/agents/<agentId>/qmd/` 下创建一个自包含的 QMD 主目录，并自动管理侧车生命周期 —— 为你处理集合、更新和嵌入运行。它优先使用当前的 QMD 集合和 MCP 查询形状，但在需要时仍会回退到旧的 `--mask` 集合标志和较旧的 MCP 工具名称。

## 侧车工作原理

- OpenClaw 从你的工作区内存文件和任何配置的 `memory.qmd.paths` 创建集合，然后在启动时和定期（默认每 5 分钟）运行 `qmd update` + `qmd embed`。
- 默认工作区集合跟踪 `MEMORY.md` 加上 `memory/` 树。小写的 `memory.md` 仍然是引导回退，而不是单独的 QMD 集合。
- 启动刷新在后台运行，因此聊天启动不会被阻塞。
- 搜索使用配置的 `searchMode`（默认：`search`；也支持 `vsearch` 和 `query`）。如果一种模式失败，OpenClaw 会使用 `qmd query` 重试。
- 如果 QMD 完全失败，OpenClaw 会回退到内置的 SQLite 引擎。

<Info>
第一次搜索可能很慢 —— QMD 会在第一次 `qmd query` 运行时自动下载 GGUF 模型（约 2 GB）用于重排序和查询扩展。
</Info>

## 模型覆盖

QMD 模型环境变量从网关进程不变地传递，因此你可以全局调整 QMD 而无需添加新的 OpenClaw 配置：

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
export QMD_RERANK_MODEL="/absolute/path/to/reranker.gguf"
export QMD_GENERATE_MODEL="/absolute/path/to/generator.gguf"
```

更改嵌入模型后，重新运行嵌入，使索引与新的向量空间匹配。

## 索引额外路径

将 QMD 指向其他目录，使它们可搜索：

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      paths: [{ name: "docs", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

来自额外路径的片段在搜索结果中显示为 `qmd/<collection>/<relative-path>`。`memory_get` 理解这个前缀并从正确的集合根目录读取。

## 索引会话记录

启用会话索引以回忆 earlier 对话：

```json5
{
  memory: {
    backend: "qmd",
    qmd: {
      sessions: { enabled: true },
    },
  },
}
```

记录被导出为经过清理的 User/Assistant 回合，进入 `~/.openclaw/agents/<id>/qmd/sessions/` 下的专用 QMD 集合。

## 搜索范围

默认情况下，QMD 搜索结果会在直接和频道会话（而非群组）中显示。配置 `memory.qmd.scope` 来更改这一点：

```json5
{
  memory: {
    qmd: {
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
    },
  },
}
```

当范围拒绝搜索时，OpenClaw 会记录一个带有派生频道和聊天类型的警告，以便更容易调试空结果。

## 引用

当 `memory.citations` 为 `auto` 或 `on` 时，搜索片段会包含 `Source: <path#line>` 页脚。设置 `memory.citations = "off"` 以省略页脚，同时仍将路径内部传递给代理。

## 使用时机

当你需要以下功能时选择 QMD：

- 重排序以获得更高质量的结果。
- 搜索工作区外的项目文档或笔记。
- 回忆过去的会话对话。
- 无需 API 密钥的完全本地搜索。

对于更简单的设置，[内置引擎](/concepts/memory-builtin) 在没有额外依赖的情况下工作良好。

## 故障排除

**找不到 QMD？** 确保二进制文件在网关的 `PATH` 中。如果 OpenClaw 作为服务运行，创建一个符号链接：`sudo ln -s ~/.bun/bin/qmd /usr/local/bin/qmd`。

**第一次搜索非常慢？** QMD 在首次使用时下载 GGUF 模型。使用与 OpenClaw 相同的 XDG 目录通过 `qmd query "test"` 预热。

**搜索超时？** 增加 `memory.qmd.limits.timeoutMs`（默认：4000ms）。对于较慢的硬件，设置为 `120000`。

**群聊中的空结果？** 检查 `memory.qmd.scope` —— 默认只允许直接和频道会话。

**工作区可见的临时仓库导致 `ENAMETOOLONG` 或索引损坏？** QMD 遍历当前遵循底层 QMD 扫描器行为，而不是 OpenClaw 的内置符号链接规则。将临时 monorepo 检出保持在隐藏目录（如 `.tmp/`）或索引的 QMD 根目录之外，直到 QMD 公开循环安全遍历或显式排除控制。

## 配置

有关完整的配置表面（`memory.qmd.*`）、搜索模式、更新间隔、范围规则和所有其他选项，请参阅 [内存配置参考](/reference/memory-config)。
