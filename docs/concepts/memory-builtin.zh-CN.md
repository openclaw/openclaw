---
title: "内置内存引擎"
summary: "默认的基于SQLite的内存后端，支持关键字、向量和混合搜索"
read_when:
  - 你想了解默认内存后端
  - 你想配置嵌入提供程序或混合搜索
---

# 内置内存引擎

内置引擎是默认的内存后端。它将内存索引存储在每个代理的SQLite数据库中，不需要额外的依赖项即可开始使用。

## 它提供什么

- **关键字搜索** 通过FTS5全文索引（BM25评分）。
- **向量搜索** 通过任何支持的提供程序的嵌入。
- **混合搜索** 结合两者以获得最佳结果。
- **CJK支持** 通过三元组分词支持中文、日文和韩文。
- **sqlite-vec加速** 用于数据库内向量查询（可选）。

## 快速开始

如果你有OpenAI、Gemini、Voyage或Mistral的API密钥，内置引擎会自动检测并启用向量搜索。无需配置。

要明确设置提供程序：

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

没有嵌入提供程序时，只能使用关键字搜索。

## 支持的嵌入提供程序

| 提供程序 | ID        | 自动检测   | 说明                           |
| -------- | --------- | ---------- | ------------------------------ |
| OpenAI   | `openai`  | 是         | 默认：`text-embedding-3-small` |
| Gemini   | `gemini`  | 是         | 支持多模态（图像 + 音频）      |
| Voyage   | `voyage`  | 是         |                                |
| Mistral  | `mistral` | 是         |                                |
| Ollama   | `ollama`  | 否         | 本地，需明确设置               |
| Local    | `local`   | 是（首选） | GGUF模型，约0.6 GB下载         |

自动检测会按照显示的顺序选择第一个可以解析API密钥的提供程序。设置`memorySearch.provider`以覆盖。

## 索引如何工作

OpenClaw将`MEMORY.md`和`memory/*.md`索引为块（约400个令牌，80个令牌重叠），并将它们存储在每个代理的SQLite数据库中。

- **索引位置：** `~/.openclaw/memory/<agentId>.sqlite`
- **文件监视：** 内存文件的更改会触发防抖重新索引（1.5秒）。
- **自动重新索引：** 当嵌入提供程序、模型或分块配置更改时，整个索引会自动重建。
- **按需重新索引：** `openclaw memory index --force`

<Info>
你也可以使用`memorySearch.extraPaths`索引工作区外的Markdown文件。请参阅
[配置参考](/reference/memory-config#additional-memory-paths)。
</Info>

## 何时使用

内置引擎是大多数用户的正确选择：

- 开箱即用，无额外依赖。
- 很好地处理关键字和向量搜索。
- 支持所有嵌入提供程序。
- 混合搜索结合了两种检索方法的优点。

如果你需要重排序、查询扩展或想要索引工作区外的目录，请考虑切换到[QMD](/concepts/memory-qmd)。

如果你想要具有自动用户建模的跨会话内存，请考虑[Honcho](/concepts/memory-honcho)。

## 故障排除

**内存搜索已禁用？** 检查`openclaw memory status`。如果未检测到提供程序，请明确设置一个或添加API密钥。

**结果过时？** 运行`openclaw memory index --force`重建。在罕见的边缘情况下，监视器可能会错过更改。

**sqlite-vec未加载？** OpenClaw会自动回退到进程内余弦相似度。检查日志以了解具体的加载错误。

## 配置

有关嵌入提供程序设置、混合搜索调优（权重、MMR、时间衰减）、批处理索引、多模态内存、sqlite-vec、额外路径和所有其他配置选项，请参阅
[内存配置参考](/reference/memory-config)。
