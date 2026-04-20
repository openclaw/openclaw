---
summary: "Exa AI 搜索 -- 带有内容提取的神经和关键词搜索"
read_when:
  - 你想要使用 Exa 进行 web_search
  - 你需要 EXA_API_KEY
  - 你想要神经搜索或内容提取
title: "Exa 搜索"
---

# Exa 搜索

OpenClaw 支持 [Exa AI](https://exa.ai/) 作为 `web_search` 提供者。Exa 提供神经、关键词和混合搜索模式，带有内置的内容提取（高亮、文本、摘要）。

## 获取 API 密钥

<Steps>
  <Step title="创建账户">
    在 [exa.ai](https://exa.ai/) 注册并从你的仪表板生成 API 密钥。
  </Step>
  <Step title="存储密钥">
    在 Gateway 环境中设置 `EXA_API_KEY`，或通过以下方式配置：

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## 配置

```json5
{
  plugins: {
    entries: {
      exa: {
        config: {
          webSearch: {
            apiKey: "exa-...", // 如果设置了 EXA_API_KEY，则可选
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "exa",
      },
    },
  },
}
```

**环境替代方案：** 在 Gateway 环境中设置 `EXA_API_KEY`。对于网关安装，将其放在 `~/.openclaw/.env` 中。

## 工具参数

| 参数          | 描述                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `query`       | 搜索查询（必需）                                                       |
| `count`       | 返回结果数（1-100）                                                     |
| `type`        | 搜索模式：`auto`、`neural`、`fast`、`deep`、`deep-reasoning` 或 `instant` |
| `freshness`   | 时间过滤器：`day`、`week`、`month` 或 `year`                                |
| `date_after`  | 此日期之后的结果（YYYY-MM-DD）                                          |
| `date_before` | 此日期之前的结果（YYYY-MM-DD）                                         |
| `contents`    | 内容提取选项（见下文）                                        |

### 内容提取

Exa 可以在搜索结果旁边返回提取的内容。传递 `contents` 对象以启用：

```javascript
await web_search({
  query: "transformer architecture explained",
  type: "neural",
  contents: {
    text: true, // 完整页面文本
    highlights: { numSentences: 3 }, // 关键句子
    summary: true, // AI 摘要
  },
});
```

| 内容选项 | 类型                                                                  | 描述            |
| --------------- | --------------------------------------------------------------------- | ---------------------- |
| `text`          | `boolean \| { maxCharacters }`                                        | 提取完整页面文本 |
| `highlights`    | `boolean \| { maxCharacters, query, numSentences, highlightsPerUrl }` | 提取关键句子  |
| `summary`       | `boolean \| { query }`                                                | AI 生成的摘要   |

### 搜索模式

| 模式             | 描述                       |
| ---------------- | --------------------------------- |
| `auto`           | Exa 选择最佳模式（默认） |
| `neural`         | 语义/基于意义的搜索     |
| `fast`           | 快速关键词搜索              |
| `deep`           | 彻底的深度搜索              |
| `deep-reasoning` | 带推理的深度搜索        |
| `instant`        | 最快的结果                   |

## 注意

- 如果未提供 `contents` 选项，Exa 默认使用 `{ highlights: true }`，因此结果包含关键句子摘录
- 结果保留 Exa API 响应中的 `highlightScores` 和 `summary` 字段（如果可用）
- 结果描述首先从高亮解析，然后是摘要，然后是完整文本 —— 以可用者为准
- `freshness` 和 `date_after`/`date_before` 不能组合使用 —— 使用一种时间过滤模式
- 每个查询最多可返回 100 个结果（受 Exa 搜索类型限制）
- 结果默认缓存 15 分钟（可通过 `cacheTtlMinutes` 配置）
- Exa 是具有结构化 JSON 响应的官方 API 集成

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Brave Search](/tools/brave-search) -- 带有国家/语言过滤器的结构化结果
- [Perplexity Search](/tools/perplexity-search) -- 带有域过滤的结构化结果