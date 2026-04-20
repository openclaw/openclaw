---
summary: "用于 web_search 的 Brave Search API 设置"
read_when:
  - 你想使用 Brave Search 进行 web_search
  - 你需要 BRAVE_API_KEY 或计划详情
title: "Brave 搜索"
---

# Brave 搜索 API

OpenClaw 支持将 Brave Search API 作为 `web_search` 提供者。

## 获取 API 密钥

1. 在 [https://brave.com/search/api/](https://brave.com/search/api/) 创建 Brave Search API 账户
2. 在仪表板中，选择 **Search** 计划并生成 API 密钥。
3. 将密钥存储在配置中或在 Gateway 环境中设置 `BRAVE_API_KEY`。

## 配置示例

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "BRAVE_API_KEY_HERE",
            mode: "web", // 或 "llm-context"
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "brave",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

特定于提供者的 Brave 搜索设置现在位于 `plugins.entries.brave.config.webSearch.*` 下。
传统的 `tools.web.search.apiKey` 仍然通过兼容性垫片加载，但它不再是规范的配置路径。

`webSearch.mode` 控制 Brave 传输：

- `web`（默认）：带标题、URL 和摘要的正常 Brave 网络搜索
- `llm-context`：带预提取文本块和用于基础的来源的 Brave LLM Context API

## 工具参数

| 参数          | 描述                                                         |
| ------------- | ------------------------------------------------------------------- |
| `query`       | 搜索查询（必需）                                             |
| `count`       | 要返回的结果数量（1-10，默认：5）                      |
| `country`     | 2 字母 ISO 国家代码（例如，"US"、"DE"）                        |
| `language`    | 搜索结果的 ISO 639-1 语言代码（例如，"en"、"de"、"fr"） |
| `search_lang` | Brave 搜索语言代码（例如，`en`、`en-gb`、`zh-hans`）         |
| `ui_lang`     | UI 元素的 ISO 语言代码                                   |
| `freshness`   | 时间过滤器：`day`（24 小时）、`week`、`month` 或 `year`                |
| `date_after`  | 仅包含此日期之后发布的结果（YYYY-MM-DD）                 |
| `date_before` | 仅包含此日期之前发布的结果（YYYY-MM-DD）                |

**示例：**

```javascript
// 特定国家和语言的搜索
await web_search({
  query: "可再生能源",
  country: "DE",
  language: "de",
});

// 最近结果（过去一周）
await web_search({
  query: "AI 新闻",
  freshness: "week",
});

// 日期范围搜索
await web_search({
  query: "AI 发展",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## 注意事项

- OpenClaw 使用 Brave **Search** 计划。如果你有旧的订阅（例如，原始的每月 2,000 次查询的免费计划），它仍然有效，但不包括较新的功能，如 LLM Context 或更高的速率限制。
- 每个 Brave 计划都包含 **每月 5 美元的免费信用额度**（可再生）。Search 计划每 1,000 次请求收费 5 美元，因此信用额度涵盖每月 1,000 次查询。在 Brave 仪表板中设置使用限制，以避免意外收费。有关当前计划，请参阅 [Brave API 门户](https://brave.com/search/api/)。
- Search 计划包括 LLM Context 端点和 AI 推理权限。存储结果以训练或调整模型需要具有明确存储权限的计划。请参阅 Brave [服务条款](https://api-dashboard.search.brave.com/terms-of-service)。
- `llm-context` 模式返回基础来源条目，而不是正常的网络搜索摘要形状。
- `llm-context` 模式不支持 `ui_lang`、`freshness`、`date_after` 或 `date_before`。
- `ui_lang` 必须包含区域子标签，如 `en-US`。
- 结果默认缓存 15 分钟（可通过 `cacheTtlMinutes` 配置）。

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Perplexity 搜索](/tools/perplexity-search) -- 带域过滤的结构化结果
- [Exa 搜索](/tools/exa-search) -- 带内容提取的神经搜索