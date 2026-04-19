---
title: "内置记忆引擎"
summary: "默认的基于SQLite的记忆后端，支持关键词、向量和混合搜索"
read_when:
  - 你想了解默认的记忆后端
  - 你想配置嵌入提供者或混合搜索
---

# 内置记忆引擎

内置引擎是默认的记忆后端。它将你的记忆索引存储在每个代理的SQLite数据库中，不需要额外依赖即可开始使用。

## 它提供什么

- **关键词搜索**通过FTS5全文索引（BM25评分）。
- **向量搜索**通过任何支持的提供者的嵌入。
- **混合搜索**结合两者以获得最佳结果。
- **CJK支持**通过三元组分词，支持中文、日语和韩语。
- **sqlite-vec加速**用于数据库内向量查询（可选）。

## 入门

如果你有OpenAI、Gemini、Voyage或Mistral的API密钥，内置引擎会自动检测并启用向量搜索。无需配置。

要明确设置提供者：

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
      },
    },
  },
}
```

没有嵌入提供者时，只有关键词搜索可用。

## 支持的嵌入提供者

| 提供者  | ID        | 自动检测   | 备注                           |
| ------- | --------- | ---------- | ------------------------------ |
| OpenAI  | `openai`  | 是         | 默认：`text-embedding-3-small` |
| Gemini  | `gemini`  | 是         | 支持多模态（图像 + 音频）      |
| Voyage  | `voyage`  | 是         |                                |
| Mistral | `mistral` | 是         |                                |
| Ollama  | `ollama`  | 否         | 本地，需明确设置               |
| 本地    | `local`   | 是（首选） | GGUF模型，~0.6 GB下载          |

自动检测按显示顺序选择第一个可以解析API密钥的提供者。设置`memorySearch.provider`以覆盖。

## 索引如何工作

OpenClaw将`MEMORY.md`和`memory/*.md`索引为块（~400个令牌，80个令牌重叠）并将它们存储在每个代理的SQLite数据库中。

- **索引位置：** `~/.openclaw/memory/<agentId>.sqlite`
- **文件监视：** 内存文件的更改触发防抖重新索引（1.5秒）。
- **自动重新索引：** 当嵌入提供者、模型或分块配置更改时，整个索引会自动重建。
- **按需重新索引：** `openclaw memory index --force`

<Info>
你也可以使用`memorySearch.extraPaths`索引工作区外的Markdown文件。请参阅
[配置参考](/reference/memory-config#additional-memory-paths)。
</Info>

## 何时使用

内置引擎是大多数用户的正确选择：

- 开箱即用，无需额外依赖。
- 良好处理关键词和向量搜索。
- 支持所有嵌入提供者。
- 混合搜索结合了两种检索方法的优点。

如果你需要重排序、查询扩展，或者想要索引工作区外的目录，请考虑切换到[QMD](/concepts/memory-qmd)。

如果你想要跨会话记忆和自动用户建模，请考虑[Honcho](/concepts/memory-honcho)。

## 故障排除

**记忆搜索已禁用？** 检查`openclaw memory status`。如果未检测到提供者，请明确设置一个或添加API密钥。

**结果过时？** 运行`openclaw memory index --force`重建。在罕见的边缘情况下，监视器可能会错过更改。

**sqlite-vec未加载？** OpenClaw会自动回退到进程内余弦相似度。检查日志以获取具体的加载错误。

## 配置

有关嵌入提供者设置、混合搜索调优（权重、MMR、时间衰减）、批处理索引、多模态记忆、sqlite-vec、额外路径和所有其他配置旋钮，请参阅
[记忆配置参考](/reference/memory-config)。
