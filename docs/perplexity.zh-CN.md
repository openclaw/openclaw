---
summary: "Perplexity Search API 和 Sonar/OpenRouter 对 web_search 的兼容性"
read_when:
  - 您想将 Perplexity Search 用于网络搜索
  - 您需要 PERPLEXITY_API_KEY 或 OPENROUTER_API_KEY 设置
title: "Perplexity Search（旧路径）"
---

# Perplexity Search API

OpenClaw 支持 Perplexity Search API 作为 `web_search` 提供商。它返回带有 `title`、`url` 和 `snippet` 字段的结构化结果。

为了兼容性，OpenClaw 还支持旧的 Perplexity Sonar/OpenRouter 设置。如果您使用 `OPENROUTER_API_KEY`、`plugins.entries.perplexity.config.webSearch.apiKey` 中的 `sk-or-...` 密钥，或设置 `plugins.entries.perplexity.config.webSearch.baseUrl` / `model`，则提供程序切换到聊天完成路径，并返回带有引用的 AI 综合答案，而不是结构化的搜索 API 结果。

## 获取 Perplexity API 密钥

1. 在 [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) 创建 Perplexity 帐户
2. 在仪表板中生成 API 密钥
3. 将密钥存储在配置中，或在网关环境中设置 `PERPLEXITY_API_KEY`。

## OpenRouter 兼容性

如果您已经在为 Perplexity Sonar 使用 OpenRouter，请保持 `provider: "perplexity"` 并在网关环境中设置 `OPENROUTER_API_KEY`，或在 `plugins.entries.perplexity.config.webSearch.apiKey` 中存储 `sk-or-...` 密钥。

可选的兼容性控件：

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## 配置示例

### 本机 Perplexity Search API

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

### OpenRouter / Sonar 兼容性

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "<openrouter-api-key>",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

## 在哪里设置密钥

**通过配置：** 运行 `openclaw configure --section web`。它将密钥存储在 `~/.openclaw/openclaw.json` 中的 `plugins.entries.perplexity.config.webSearch.apiKey` 下。该字段还接受 SecretRef 对象。

**通过环境：** 在网关进程环境中设置 `PERPLEXITY_API_KEY` 或 `OPENROUTER_API_KEY`。对于网关安装，将其放在 `~/.openclaw/.env`（或您的服务环境）中。请参阅 [环境变量](/help/faq#env-vars-and-env-loading)。

如果配置了 `provider: "perplexity"` 且 Perplexity 密钥 SecretRef 未解析且没有环境回退，则启动/重新加载会快速失败。

## 工具参数

这些参数适用于本机 Perplexity Search API 路径。

| 参数                  | 描述                                                    |
| --------------------- | ------------------------------------------------------- |
| `query`               | 搜索查询（必填）                                        |
| `count`               | 要返回的结果数（1-10，默认：5）                         |
| `country`             | 2 字母 ISO 国家代码（例如，"US"、"DE"）                 |
| `language`            | ISO 639-1 语言代码（例如，"en"、"de"、"fr"）            |
| `freshness`           | 时间过滤器：`day`（24 小时）、`week`、`month` 或 `year` |
| `date_after`          | 仅在此日期之后发布的结果（YYYY-MM-DD）                  |
| `date_before`         | 仅在此日期之前发布的结果（YYYY-MM-DD）                  |
| `domain_filter`       | 域允许列表/拒绝列表数组（最多 20 个）                   |
| `max_tokens`          | 总内容预算（默认：25000，最大：1000000）                |
| `max_tokens_per_page` | 每页令牌限制（默认：2048）                              |

对于旧的 Sonar/OpenRouter 兼容性路径：

- 接受 `query`、`count` 和 `freshness`
- `count` 仅在那里是兼容性的；响应仍然是一个带有引用的综合答案，而不是 N 结果列表
- 仅搜索 API 的过滤器，如 `country`、`language`、`date_after`、`date_before`、`domain_filter`、`max_tokens` 和 `max_tokens_per_page` 返回显式错误

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

// 域过滤（允许列表）
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// 域过滤（拒绝列表 - 前缀为 -）
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// 更多内容提取
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

### 域过滤规则

- 每个过滤器最多 20 个域
- 不能在同一请求中混合允许列表和拒绝列表
- 对拒绝列表条目使用 `-` 前缀（例如，`["-reddit.com"]`）

## 注意事项

- Perplexity Search API 返回结构化的网络搜索结果（`title`、`url`、`snippet`）
- OpenRouter 或显式 `plugins.entries.perplexity.config.webSearch.baseUrl` / `model` 为了兼容性将 Perplexity 切换回 Sonar 聊天完成
- Sonar/OpenRouter 兼容性返回一个带有引用的综合答案，而不是结构化结果行
- 结果默认缓存 15 分钟（可通过 `cacheTtlMinutes` 配置）

有关完整的 web_search 配置，请参阅 [Web 工具](/tools/web)。
有关更多详细信息，请参阅 [Perplexity Search API 文档](https://docs.perplexity.ai/docs/search/quickstart)。
