---
summary: "web_search 的 Brave Search API 设置"
read_when:
  - 您想将 Brave Search 用于 web_search
  - 您需要 BRAVE_API_KEY 或计划详细信息
title: "Brave Search（旧路径）"
---

# Brave Search API

OpenClaw 支持 Brave Search API 作为 `web_search` 提供商。

## 获取 API 密钥

1. 在 [https://brave.com/search/api/](https://brave.com/search/api/) 创建 Brave Search API 帐户
2. 在仪表板中，选择**Search**计划并生成 API 密钥。
3. 将密钥存储在配置中，或在网关环境中设置 `BRAVE_API_KEY`。

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

特定于提供程序的 Brave 搜索设置现在位于 `plugins.entries.brave.config.webSearch.*` 下。旧的 `tools.web.search.apiKey` 仍通过兼容性填充程序加载，但它不再是规范配置路径。

`webSearch.mode` 控制 Brave 传输：

- `web`（默认）：带有标题、URL 和片段的正常 Brave 网络搜索
- `llm-context`：带有预提取文本块和源用于基础的 Brave LLM Context API

## 工具参数

| 参数          | 描述                                                    |
| ------------- | ------------------------------------------------------- |
| `query`       | 搜索查询（必填）                                        |
| `count`       | 要返回的结果数（1-10，默认：5）                         |
| `country`     | 2 字母 ISO 国家代码（例如，"US"、"DE"）                 |
| `language`    | 搜索结果的 ISO 639-1 语言代码（例如，"en"、"de"、"fr"） |
| `search_lang` | Brave 搜索语言代码（例如，`en`、`en-gb`、`zh-hans`）    |
| `ui_lang`     | UI 元素的 ISO 语言代码                                  |
| `freshness`   | 时间过滤器：`day`（24 小时）、`week`、`month` 或 `year` |
| `date_after`  | 仅在此日期之后发布的结果（YYYY-MM-DD）                  |
| `date_before` | 仅在此日期之前发布的结果（YYYY-MM-DD）                  |

**示例：**

```javascript
// 特定于国家和语言的搜索
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});

// 近期结果（过去一周）
await web_search({
  query: "AI news",
  freshness: "week",
});

// 日期范围搜索
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## 注意事项

- OpenClaw 使用 Brave **Search** 计划。如果您有旧订阅（例如，原始的免费计划，每月 2,000 次查询），它仍然有效，但不包括较新的功能，如 LLM Context 或更高的速率限制。
- 每个 Brave 计划包括**\$5/月的免费信用**（续订）。Search 计划每 1,000 次请求花费 \$5，因此信用额度每月覆盖 1,000 次查询。在 Brave 仪表板中设置您的使用限制以避免意外费用。有关当前计划，请参阅 [Brave API 门户](https://brave.com/search/api/)。
- Search 计划包括 LLM Context 端点和 AI 推理权限。存储结果以训练或调优模型需要具有显式存储权限的计划。请参阅 Brave [服务条款](https://api-dashboard.search.brave.com/terms-of-service)。
- `llm-context` 模式返回有根的源条目，而不是正常的网络搜索片段形状。
- `llm-context` 模式不支持 `ui_lang`、`freshness`、`date_after` 或 `date_before`。
- `ui_lang` 必须包含区域子标签，如 `en-US`。
- 结果默认缓存 15 分钟（可通过 `cacheTtlMinutes` 配置）。

有关完整的 web_search 配置，请参阅 [Web 工具](/tools/web)。
