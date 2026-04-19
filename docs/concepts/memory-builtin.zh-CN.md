---
title: "内置内存引擎"
summary: "默认的基于 SQLite 的内存后端，具有关键词、向量和混合搜索"
read_when:
  - 你想了解默认内存后端
  - 你想配置嵌入提供商或混合搜索
---

# 内置内存引擎

内置引擎是默认的内存后端。它将内存索引存储在每个代理的 SQLite 数据库中，无需额外依赖即可开始使用。

## 提供的功能

- **关键词搜索** 通过 FTS5 全文索引（BM25 评分）。
- **向量搜索** 通过任何支持的提供商的嵌入。
- **混合搜索** 结合两者以获得最佳结果。
- **CJK 支持** 通过三元组标记化支持中文、日语和韩语。
- **sqlite-vec 加速** 用于数据库内向量查询（可选）。

## 入门

如果你有 OpenAI、Gemini、Voyage 或 Mistral 的 API 密钥，内置引擎会自动检测并启用向量搜索。无需配置。

要明确设置提供商：

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

没有嵌入提供商时，只有关键词搜索可用。

## 支持的嵌入提供商

| 提供商  | ID        | 自动检测   | 说明                           |
| ------- | --------- | ---------- | ------------------------------ |
| OpenAI  | `openai`  | 是         | 默认：`text-embedding-3-small` |
| Gemini  | `gemini`  | 是         | 支持多模态（图像 + 音频）      |
| Voyage  | `voyage`  | 是         |                                |
| Mistral | `mistral` | 是         |                                |
| Ollama  | `ollama`  | 否         | 本地，需明确设置               |
| Local   | `local`   | 是（首选） | GGUF 模型，~0.6 GB 下载        |

自动检测按所示顺序选择第一个可以解析 API 密钥的提供商。设置 `memorySearch.provider` 以覆盖。

## 索引工作原理

OpenClaw 将 `MEMORY.md` 和 `memory/*.md` 索引为块（~400 令牌，80 令牌重叠）并将它们存储在每个代理的 SQLite 数据库中。

- **索引位置：** `~/.openclaw/memory/<agentId>.sqlite`
- **文件监视：** 内存文件的更改会触发防抖重新索引（1.5s）。
- **自动重新索引：** 当嵌入提供商、模型或分块配置更改时，整个索引会自动重建。
- **按需重新索引：** `openclaw memory index --force`

<Info>
你还可以使用 `memorySearch.extraPaths` 索引工作区外的 Markdown 文件。请参阅
[配置参考](/reference/memory-config#additional-memory-paths)。
</Info>

## 使用时机

内置引擎是大多数用户的正确选择：

- 开箱即用，无需额外依赖。
- 很好地处理关键词和向量搜索。
- 支持所有嵌入提供商。
- 混合搜索结合了两种检索方法的优点。

如果你需要重排序、查询扩展，或想索引工作区外的目录，请考虑切换到 [QMD](/concepts/memory-qmd)。

如果你想要跨会话内存和自动用户建模，请考虑 [Honcho](/concepts/memory-honcho)。

## 故障排除

**内存搜索已禁用？** 检查 `openclaw memory status`。如果未检测到提供商，请明确设置一个或添加 API 密钥。

**结果过时？** 运行 `openclaw memory index --force` 重建。在罕见的边缘情况下，监视器可能会错过更改。

**sqlite-vec 未加载？** OpenClaw 会自动回退到进程内余弦相似度。检查日志以获取具体的加载错误。

## 配置

有关嵌入提供商设置、混合搜索调优（权重、MMR、时间衰减）、批处理索引、多模态内存、sqlite-vec、额外路径和所有其他配置旋钮，请参阅
[内存配置参考](/reference/memory-config)。
