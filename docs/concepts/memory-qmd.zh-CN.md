---
title: "QMD记忆引擎"
summary: "本地优先的搜索边车，具有BM25、向量、重排序和查询扩展"
read_when:
  - 你想设置QMD作为你的记忆后端
  - 你想要高级记忆功能，如重排序或额外的索引路径
---

# QMD记忆引擎

[QMD](https://github.com/tobi/qmd) 是一个本地优先的搜索边车，与OpenClaw一起运行。它在单个二进制文件中结合了BM25、向量搜索和重排序，可以索引工作区记忆文件之外的内容。

## 它比内置引擎增加了什么

- **重排序和查询扩展**以获得更好的回忆。
- **索引额外目录** -- 项目文档、团队笔记、磁盘上的任何内容。
- **索引会话记录** -- 回忆早期对话。
- **完全本地** -- 通过Bun + node-llama-cpp运行，自动下载GGUF模型。
- **自动回退** -- 如果QMD不可用，OpenClaw会无缝回退到内置引擎。

## 入门

### 先决条件

- 安装QMD: `npm install -g @tobilu/qmd` 或 `bun install -g @tobilu/qmd`
- 允许扩展的SQLite构建（在macOS上使用 `brew install sqlite`）。
- QMD必须在网关的`PATH`上。
- macOS和Linux开箱即用。Windows通过WSL2支持最好。

### 启用

```json5
{
  memory: {
    backend: "qmd",
  },
}
```

OpenClaw在 `~/.openclaw/agents/<agentId>/qmd/` 下创建一个自包含的QMD主目录，并自动管理边车生命周期 -- 集合、更新和嵌入运行都由你处理。它偏好当前的QMD集合和MCP查询形状，但在需要时仍然回退到传统的 `--mask` 集合标志和较旧的MCP工具名称。

## 边车如何工作

- OpenClaw从你的工作区记忆文件和任何配置的 `memory.qmd.paths` 创建集合，然后在启动时和定期（默认每5分钟）运行 `qmd update` + `qmd embed`。
- 默认工作区集合跟踪 `MEMORY.md` 加上 `memory/` 树。小写的 `memory.md` 仍然是引导回退，不是单独的QMD集合。
- 启动刷新在后台运行，因此聊天启动不会被阻塞。
- 搜索使用配置的 `searchMode`（默认：`search`；也支持 `vsearch` 和 `query`）。如果模式失败，OpenClaw会使用 `qmd query` 重试。
- 如果QMD完全失败，OpenClaw会回退到内置的SQLite引擎。

<Info>
第一次搜索可能很慢 -- QMD在第一次 `qmd query` 运行时会自动下载GGUF模型（~2 GB）用于重排序和查询扩展。
</Info>

## 模型覆盖

QMD模型环境变量从网关进程不变地传递，因此你可以全局调优QMD而无需添加新的OpenClaw配置：

```bash
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
export QMD_RERANK_MODEL="/absolute/path/to/reranker.gguf"
export QMD_GENERATE_MODEL="/absolute/path/to/generator.gguf"
```

更改嵌入模型后，重新运行嵌入，使索引与新的向量空间匹配。

## 索引额外路径

将QMD指向其他目录以使它们可搜索：

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

来自额外路径的片段在搜索结果中显示为 `qmd/<collection>/<relative-path>`。`memory_get` 理解这个前缀并从正确的集合根读取。

## 索引会话记录

启用会话索引以回忆早期对话：

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

记录被导出为清理后的用户/助手回合，进入 `~/.openclaw/agents/<id>/qmd/sessions/` 下的专用QMD集合。

## 搜索范围

默认情况下，QMD搜索结果在直接和频道会话中显示（不包括群组）。配置 `memory.qmd.scope` 来更改这一点：

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

当范围拒绝搜索时，OpenClaw会记录带有派生频道和聊天类型的警告，以便更容易调试空结果。

## 引用

当 `memory.citations` 为 `auto` 或 `on` 时，搜索片段包括 `Source: <path#line>` 页脚。设置 `memory.citations = "off"` 以省略页脚，同时仍然在内部将路径传递给代理。

## 何时使用

当你需要以下功能时选择QMD：

- 重排序以获得更高质量的结果。
- 搜索工作区外的项目文档或笔记。
- 回忆过去的会话对话。
- 完全本地搜索，无需API密钥。

对于更简单的设置，[内置引擎](/concepts/memory-builtin) 工作良好，无需额外依赖。

## 故障排除

**找不到QMD？** 确保二进制文件在网关的 `PATH` 上。如果OpenClaw作为服务运行，创建一个符号链接：`sudo ln -s ~/.bun/bin/qmd /usr/local/bin/qmd`。

**第一次搜索非常慢？** QMD在首次使用时下载GGUF模型。使用与OpenClaw相同的XDG目录运行 `qmd query "test"` 来预热。

**搜索超时？** 增加 `memory.qmd.limits.timeoutMs`（默认：4000ms）。对于较慢的硬件，设置为 `120000`。

**群聊中结果为空？** 检查 `memory.qmd.scope` -- 默认只允许直接和频道会话。

**工作区可见的临时仓库导致 `ENAMETOOLONG` 或索引损坏？** QMD遍历当前遵循底层QMD扫描器行为，而不是OpenClaw的内置符号链接规则。将临时monorepo检出保持在隐藏目录（如 `.tmp/`）或索引的QMD根之外，直到QMD公开循环安全遍历或显式排除控制。

## 配置

有关完整的配置表面（`memory.qmd.*`）、搜索模式、更新间隔、范围规则和所有其他旋钮，请参阅
[记忆配置参考](/reference/memory-config)。
