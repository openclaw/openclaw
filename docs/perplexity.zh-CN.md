---
summary: "Perplexity Search API和Sonar/OpenRouter兼容性用于web_search"
read_when:
  - 你想使用Perplexity Search进行网络搜索
  - 你需要PERPLEXITY_API_KEY或OPENROUTER_API_KEY设置
title: "Perplexity搜索（旧路径）"
---

# Perplexity Search API

OpenClaw支持将Perplexity Search API作为`web_search`提供商。
它返回带有`title`、`url`和`snippet`字段的结构化结果。

为了兼容性，OpenClaw还支持传统的Perplexity Sonar/OpenRouter设置。
如果你使用`OPENROUTER_API_KEY`、`plugins.entries.perplexity.config.webSearch.apiKey`中的`sk-or-...`密钥，或设置`plugins.entries.perplexity.config.webSearch.baseUrl` / `model`，提供商将切换到聊天完成路径并返回带有引用的AI合成答案，而不是结构化的搜索API结果。

## 获取Perplexity API密钥

1. 在[perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)创建Perplexity账户
2. 在仪表板中生成API密钥
3. 将密钥存储在配置中或在Gateway环境中设置`PERPLEXITY_API_KEY`。

## OpenRouter兼容性

如果你已经在使用OpenRouter for Perplexity Sonar，请保持`provider: "perplexity"`并在Gateway环境中设置`OPENROUTER_API_KEY`，或将`sk-or-...`密钥存储在`plugins.entries.perplexity.config.webSearch.apiKey`中。

可选的兼容性控制：

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## 配置示例

### 原生Perplexity Search API

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

### OpenRouter / Sonar兼容性

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

**通过配置：** 运行`openclaw configure --section web`。它将密钥存储在`~/.openclaw/openclaw.json`的`plugins.entries.perplexity.config.webSearch.apiKey`下。
该字段也接受SecretRef对象。

**通过环境：** 在Gateway进程环境中设置`PERPLEXITY_API_KEY`或`OPENROUTER_API_KEY`。对于网关安装，将其放在`~/.openclaw/.env`（或你的服务环境）中。请参阅[环境变量](/help/faq#env-vars-and-env-loading)。

如果配置了`provider: "perplexity"`并且Perplexity密钥SecretRef未解析且没有环境回退，则启动/重新加载会快速失败。

## 工具参数

这些参数适用于原生Perplexity Search API路径。

| 参数                 | 描述                                          |
| --------------------- | ---------------------------------------------------- |
| `query`               | 搜索查询（必填）                              |
| `count`               | 要返回的结果数量（1-10，默认：5）       |
| `country`             | 2字母ISO国家代码（例如，"US"，"DE"）         |
| `language`            | ISO 639-1语言代码（例如，"en"，"de"，"fr"）     |
| `freshness`           | 时间过滤器：`day`（24小时），`week`，`month`或`year` |
| `date_after`          | 仅包含在此日期之后发布的结果（YYYY-MM-DD）  |
| `date_before`         | 仅包含在此日期之前发布的结果（YYYY-MM-DD） |
| `domain_filter`       | 域名允许列表/拒绝列表数组（最多20个）             |
| `max_tokens`          | 总内容预算（默认：25000，最大：1000000）  |
| `max_tokens_per_page` | 每页令牌限制（默认：2048）                 |

对于传统的Sonar/OpenRouter兼容性路径：

- 接受`query`、`count`和`freshness`
- 那里的`count`仅用于兼容性；响应仍然是一个带有引用的合成答案，而不是N结果列表
- 仅搜索API的过滤器，如`country`、`language`、`date_after`、`date_before`、`domain_filter`、`max_tokens`和`max_tokens_per_page`返回明确的错误

**示例：**

```javascript
// 特定国家和语言的搜索
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});

// 最近结果（过去一周）
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

// 域名过滤（允许列表）
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// 域名过滤（拒绝列表 - 以-开头）
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

### 域名过滤规则

- 每个过滤器最多20个域名
- 不能在同一请求中混合允许列表和拒绝列表
- 使用`-`前缀表示拒绝列表条目（例如，`["-reddit.com"]`）

## 注意事项

- Perplexity Search API返回结构化的网络搜索结果（`title`，`url`，`snippet`）
- OpenRouter或显式`plugins.entries.perplexity.config.webSearch.baseUrl` / `model`将Perplexity切换回Sonar聊天完成以保持兼容性
- Sonar/OpenRouter兼容性返回一个带有引用的合成答案，而不是结构化结果行
- 结果默认缓存15分钟（可通过`cacheTtlMinutes`配置）

有关完整的web_search配置，请参阅[Web工具](/tools/web)。
有关更多详细信息，请参阅[Perplexity Search API文档](https://docs.perplexity.ai/docs/search/quickstart)。