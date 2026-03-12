---
read_when:
  - 你想使用 Tavily Search 进行网页搜索
  - 你需要设置 TAVILY_API_KEY
summary: 用于 web_search 的 Tavily Search API 设置
title: Tavily Search
x-i18n:
  generated_at: "2026-03-12T19:09:11Z"
  model: claude-opus-4-6
  provider: pi
  source_hash: fec59a93e341fae47566f757b9a0c75bb4829f3ec47d421c2016954386091078
  source_path: tavily.md
  workflow: 15
---

# Tavily Search API

OpenClaw 支持将 Tavily 作为 `web_search` 提供商。
它返回包含 `title`、`url` 和 `snippet` 字段的结构化结果，
并支持可选的 AI 生成的答案摘要和可配置的搜索深度。

## 获取 Tavily API 密钥

1. 在 [app.tavily.com](https://app.tavily.com/) 创建 Tavily 账户
2. 在控制面板中生成 API 密钥
3. 将密钥存储在配置中，或在 Gateway 网关环境中设置 `TAVILY_API_KEY`。

## 配置示例

```json5
{
  tools: {
    web: {
      search: {
        provider: "tavily",
        tavily: {
          apiKey: "tvly-...", // optional if TAVILY_API_KEY is set
        },
      },
    },
  },
}
```

## 密钥设置位置

**通过配置：**运行 `openclaw configure --section web`。它会将密钥存储在
`~/.openclaw/openclaw.json` 的 `tools.web.search.tavily.apiKey` 中。
该字段也接受 SecretRef 对象。

**通过环境变量：**在 Gateway 网关进程环境中设置 `TAVILY_API_KEY`。对于 Gateway 网关安装，将其放在
`~/.openclaw/.env`（或你的服务环境）中。参见[环境变量](/help/faq#how-does-openclaw-load-environment-variables)。

如果配置了 `provider: "tavily"` 但 Tavily 密钥的 SecretRef 未解析且没有环境变量回退，启动/重载将快速失败。

## 工具参数

| 参数             | 描述                                                  |
| ---------------- | ----------------------------------------------------- |
| `query`          | 搜索查询（必填）                                      |
| `count`          | 返回结果数量（1-20，默认：5）                         |
| `freshness`      | 时间过滤：`day`（24 小时）、`week`、`month` 或 `year` |
| `date_after`     | 仅返回此日期之后发布的结果（YYYY-MM-DD）              |
| `date_before`    | 仅返回此日期之前发布的结果（YYYY-MM-DD）              |
| `search_depth`   | 搜索深度：`basic` 或 `advanced`（默认：`basic`）      |
| `include_answer` | 包含 AI 生成的答案摘要（布尔值）                      |
| `domain_filter`  | 域名允许/拒绝列表数组（最多 20 个）                   |

**示例：**

```javascript
// Basic search
await web_search({
  query: "renewable energy trends",
});

// Recent results (past week)
await web_search({
  query: "AI news",
  freshness: "week",
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// Advanced search with AI answer
await web_search({
  query: "climate change effects",
  search_depth: "advanced",
  include_answer: true,
});

// Domain filtering (allowlist)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Exclude domains (denylist - prefix with -)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// Mixed allowlist and denylist
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", "-reddit.com"],
});
```

### 域名过滤规则

- 每个过滤器最多 20 个域名
- 允许列表和拒绝列表条目可以在同一请求中混合使用（例如 `["nature.com", "-reddit.com"]`）
- 使用 `-` 前缀表示拒绝列表条目（例如 `["-reddit.com"]`）

## 注意事项

- Tavily 返回结构化的网页搜索结果（`title`、`url`、`snippet`）。
- `search_depth: "advanced"` 执行更深入的搜索，但延迟会略有增加。
- `include_answer: true` 会在结构化结果旁附加一个 AI 生成的摘要。
- 结果默认缓存 15 分钟（可通过 `cacheTtlMinutes` 配置）。

参见 [Web 工具](/tools/web)了解完整的 web_search 配置。
参见 [Tavily API 文档](https://docs.tavily.com)了解详情。
