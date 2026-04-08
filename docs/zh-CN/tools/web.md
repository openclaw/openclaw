---
read_when:
  - 你想启用 web_search 或 web_fetch
  - 你需要设置 Brave Search API 密钥
  - 你想使用 Perplexity Sonar 进行网络搜索
summary: Web 搜索 + 获取工具（Brave Search API、Perplexity 直连/OpenRouter）
title: Web 工具
x-i18n:
  generated_at: "2026-02-03T10:12:43Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 760b706cc966cb421e370f10f8e76047f8ca9fe0a106d90c05d979976789465a
  source_path: tools/web.md
  workflow: 15
---

# Web 工具

OpenClaw 提供两个轻量级 Web 工具：

- `web_search` — 通过 Brave Search API、Bocha Search API、Firecrawl Search、Gemini with Google Search grounding、Grok、Kimi 或 Perplexity Search API 搜索网络。
- `web_fetch` — HTTP 获取 + 可读性提取（HTML → markdown/文本）。

这些**不是**浏览器自动化。对于 JS 密集型网站或需要登录的情况，请使用[浏览器工具](/tools/browser)。

## 工作原理

- `web_search` 调用你配置的提供商并返回结果。
- 结果按查询缓存 15 分钟（可配置）。
- `web_fetch` 执行普通 HTTP GET 并提取可读内容（HTML → markdown/文本）。它**不**执行 JavaScript。
- `web_fetch` 默认启用（除非显式禁用）。
- 启用捆绑的 Firecrawl 插件后，还会提供 `firecrawl_search` 和 `firecrawl_scrape`。

## 选择搜索提供商

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    结构化结果和摘要。支持 `llm-context` 模式、国家/语言过滤器。提供免费层。
  </Card>
  <Card title="Bocha Search" icon="magnifying-glass" href="/tools/bocha-search">
    高质量 Web 搜索，提供结构化结果。最适合中文内容。
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    免密钥回退。无需 API 密钥。非官方的基于 HTML 的集成。
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    神经 + 关键词搜索，支持内容提取（高亮、文本、摘要）。
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    结构化结果。最好与 `firecrawl_search` 和 `firecrawl_scrape` 配合使用进行深度提取。
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    通过 Google Search grounding 提供的带有引用的 AI 综合答案。
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    通过 xAI 网络接地提供的带有引用的 AI 综合答案。
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    通过 Moonshot 网络搜索提供的带有引用的 AI 综合答案。
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    带有内容提取控制和域名过滤的结构化结果。
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    带有搜索深度、主题过滤和用于 URL 提取的 `tavily_extract` 的结构化结果。
  </Card>
</CardGroup>

### 提供商对比

| 提供商                                 | 结果形式          | 过滤器                               | API 密钥                                    |
| -------------------------------------- | ----------------- | ------------------------------------ | ------------------------------------------- |
| [Brave](/tools/brave-search)           | 结构化摘要        | 国家、语言、时间、`llm-context` 模式 | `BRAVE_API_KEY`                             |
| [Bocha](/tools/bocha-search)           | 结构化摘要        | 时间范围                             | `BOCHA_API_KEY`                             |
| [DuckDuckGo](/tools/duckduckgo-search) | 结构化摘要        | --                                   | 无（免密钥）                                |
| [Exa](/tools/exa-search)               | 结构化 + 提取内容 | 神经/关键词模式、日期、内容提取      | `EXA_API_KEY`                               |
| [Firecrawl](/tools/firecrawl)          | 结构化摘要        | 通过 `firecrawl_search` 工具         | `FIRECRAWL_API_KEY`                         |
| [Gemini](/tools/gemini-search)         | AI 综合 + 引用    | --                                   | `GEMINI_API_KEY`                            |
| [Grok](/tools/grok-search)             | AI 综合 + 引用    | --                                   | `XAI_API_KEY`                               |
| [Kimi](/tools/kimi-search)             | AI 综合 + 引用    | --                                   | `KIMI_API_KEY` / `MOONSHOT_API_KEY`         |
| [Perplexity](/tools/perplexity-search) | 结构化摘要        | 国家、语言、时间、域名、内容限制     | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` |
| [Tavily](/tools/tavily)                | 结构化摘要        | 通过 `tavily_search` 工具            | `TAVILY_API_KEY`                            |

参见 [Brave Search 设置](/brave-search) 和 [Perplexity Sonar](/perplexity) 了解提供商特定详情。

## 自动检测

文档和设置流程中的提供商列表按字母顺序排列。自动检测则遵循特定的优先级顺序：

如果未设置 `provider`，OpenClaw 会按以下顺序检查 API 密钥并使用找到的第一个：

1. **Brave** -- `BRAVE_API_KEY` 或 `plugins.entries.brave.config.webSearch.apiKey` (order 10)
2. **Bocha** -- `BOCHA_API_KEY` 或 `plugins.entries.bocha.config.webSearch.apiKey` (order 12)
3. **MiniMax Search** -- `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` 或 `plugins.entries.minimax.config.webSearch.apiKey` (order 15)
4. **Gemini** -- `GEMINI_API_KEY` 或 `plugins.entries.google.config.webSearch.apiKey` (order 20)
5. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY` 或 `plugins.entries.moonshot.config.webSearch.apiKey`
6. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` 或 `plugins.entries.perplexity.config.webSearch.apiKey`
7. **Firecrawl** -- `FIRECRAWL_API_KEY` 或 `plugins.entries.firecrawl.config.webSearch.apiKey`
8. **Tavily** -- `TAVILY_API_KEY` 或 `plugins.entries.tavily.config.webSearch.apiKey`

如果未找到任何密钥，它将回退到 Brave（你会看到一个错误提示，引导你进行配置）。

<Note>
  所有提供商的密钥字段都支持 SecretRef 对象。在自动检测模式下，OpenClaw 仅解析所选提供商的密钥——未选择的 SecretRef 将保持非活动状态。
</Note>

在配置中设置提供商：

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // 或 "bocha" | "firecrawl" | "gemini" | "grok" | "kimi" | "perplexity"
      },
    },
  },
}
```

示例：切换到 Perplexity Search / Sonar 兼容路径：

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
            baseUrl: "https://api.perplexity.ai",
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

## 获取 Brave API 密钥

1. 在 https://brave.com/search/api/ 创建 Brave Search API 账户
2. 在控制面板中，选择 **Data for Search** 计划（不是"Data for AI"）并生成 API 密钥。
3. 运行 `openclaw configure --section web` 将密钥存储在配置中（推荐），或在环境中设置 `BRAVE_API_KEY`。

Brave 提供免费层和付费计划；查看 Brave API 门户了解当前限制和定价。

### 在哪里设置密钥（推荐）

**推荐：** 运行 `openclaw configure --section web`。它会把密钥存储到 `~/.openclaw/openclaw.json` 的 `plugins.entries.brave.config.webSearch.apiKey`。

**环境变量替代方案：** 在 Gateway 网关进程环境中设置 `BRAVE_API_KEY`。对于 Gateway 网关安装，将其放在 `~/.openclaw/.env`（或你的服务环境）中。参见[环境变量](/help/faq#how-does-openclaw-load-environment-variables)。

## 使用 Perplexity（直连或通过 OpenRouter）

Perplexity Sonar 模型具有内置的网络搜索功能，并返回带有引用的 AI 综合答案。你可以通过 OpenRouter 使用它们（无需信用卡 - 支持加密货币/预付费）。

### 获取 OpenRouter API 密钥

1. 在 https://openrouter.ai/ 创建账户
2. 添加额度（支持加密货币、预付费或信用卡）
3. 在账户设置中生成 API 密钥

### 设置 Perplexity 搜索

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
      },
    },
  },
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            // API 密钥（如果设置了 OPENROUTER_API_KEY 或 PERPLEXITY_API_KEY 则可选）
            apiKey: "sk-or-v1-...",
            // 基础 URL（如果省略则根据密钥感知默认值）
            baseUrl: "https://openrouter.ai/api/v1",
            // 模型（默认为 perplexity/sonar-pro）
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
}
```

**环境变量替代方案：** 在 Gateway 网关环境中设置 `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY`。对于 Gateway 网关安装，将其放在 `~/.openclaw/.env` 中。

如果未设置基础 URL，OpenClaw 会根据 API 密钥来源选择默认值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 或 `sk-or-...` → `https://openrouter.ai/api/v1`
- 未知密钥格式 → OpenRouter（安全回退）

### 可用的 Perplexity 模型

| 模型                             | 描述                 | 最适合   |
| -------------------------------- | -------------------- | -------- |
| `perplexity/sonar`               | 带网络搜索的快速问答 | 快速查询 |
| `perplexity/sonar-pro`（默认）   | 带网络搜索的多步推理 | 复杂问题 |
| `perplexity/sonar-reasoning-pro` | 思维链分析           | 深度研究 |

## web_search

使用配置的提供商搜索网络。

### 要求

- `tools.web.search.enabled` 不能为 `false`（默认：启用）
- 所选提供商的 API 密钥：
  - **Brave**：`BRAVE_API_KEY` 或 `plugins.entries.brave.config.webSearch.apiKey`
  - **Bocha**：`BOCHA_API_KEY` 或 `plugins.entries.bocha.config.webSearch.apiKey`
  - **Perplexity**：`OPENROUTER_API_KEY`、`PERPLEXITY_API_KEY` 或 `plugins.entries.perplexity.config.webSearch.apiKey`

### 配置

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "BRAVE_API_KEY_HERE",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        enabled: true,
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

提供商专属的 web_search 配置现在统一放在 `plugins.entries.<plugin>.config.webSearch.*`。
旧的 `tools.web.search.*` 提供商路径仅作为兼容层暂时保留，不应再用于新配置。

### 工具参数

- `query`（必需）
- `count`（1–10；默认来自配置）
- `country`（可选）：用于特定地区结果的 2 字母国家代码（例如"DE"、"US"、"ALL"）。如果省略，Brave 选择其默认地区。
- `search_lang`（可选）：搜索结果的 ISO 语言代码（例如"de"、"en"、"fr"）
- `ui_lang`（可选）：UI 元素的 ISO 语言代码
- `freshness`（可选）：按发现时间过滤。Brave 使用 `pd`、`pw`、`pm`、`py` 或日期范围；Bocha 使用 `oneDay`、`oneWeek`、`oneMonth`、`oneYear` 或 `noLimit`。
- `summary`（可选，仅限 Bocha）：是否返回网页原始正文内容（默认：`true`）

**示例：**

```javascript
// 德国特定搜索
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// 带法语 UI 的法语搜索
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// 最近结果（过去一周）
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

获取 URL 并提取可读内容。

### 要求

- `tools.web.fetch.enabled` 不能为 `false`（默认：启用）
- 可选的 Firecrawl 回退：设置 `tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`。

### 配置

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // 如果设置了 FIRECRAWL_API_KEY 则可选
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // 毫秒（1 天）
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### 工具参数

- `url`（必需，仅限 http/https）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截断长页面）

注意：

- `web_fetch` 首先使用 Readability（主要内容提取），然后使用 Firecrawl（如果已配置）。如果两者都失败，工具返回错误。
- Firecrawl 请求使用机器人规避模式并默认缓存结果。
- `web_fetch` 默认发送类 Chrome 的 User-Agent 和 `Accept-Language`；如需要可覆盖 `userAgent`。
- `web_fetch` 阻止私有/内部主机名并重新检查重定向（用 `maxRedirects` 限制）。
- `web_fetch` 是尽力提取；某些网站需要浏览器工具。
- 参见 [Firecrawl](/tools/firecrawl) 了解密钥设置和服务详情。
- 响应会被缓存（默认 15 分钟）以减少重复获取。
- 如果你使用工具配置文件/允许列表，添加 `web_search`/`web_fetch` 或 `group:web`。
- 如果缺少 Brave 密钥，`web_search` 返回一个简短的设置提示和文档链接。
