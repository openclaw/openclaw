---
read_when:
  - 你想启用 web_search 或 web_fetch
  - 你需要设置 Brave Search API 密钥
  - 你想使用 Perplexity Sonar 进行网页搜索
summary: 网页搜索 + 抓取工具（Brave Search API、Perplexity 直连/OpenRouter）
title: 网页工具
x-i18n:
  generated_at: "2026-02-01T21:43:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 760b706cc966cb421e370f10f8e76047f8ca9fe0a106d90c05d979976789465a
  source_path: tools/web.md
  workflow: 15
---

# 网页工具

OpenClaw 内置两个轻量级网页工具：

- `web_search` — 通过 Brave Search API（默认）或 Perplexity Sonar（直连或通过 OpenRouter）搜索网页。
- `web_fetch` — HTTP 抓取 + 可读内容提取（HTML → markdown/文本）。

这些**不是**浏览器自动化。对于 JS 密集型网站或需要登录的场景，请使用
[浏览器工具](/tools/browser)。

## 工作原理

- `web_search` 调用你配置的提供商并返回结果。
  - **Brave**（默认）：返回结构化结果（标题、URL、摘要）。
  - **Perplexity**：返回基于实时网页搜索的 AI 综合答案及引用来源。
- 结果按查询缓存 15 分钟（可配置）。
- `web_fetch` 执行普通 HTTP GET 并提取可读内容
  （HTML → markdown/文本）。它**不会**执行 JavaScript。
- `web_fetch` 默认启用（除非显式禁用）。

## 选择搜索提供商

| 提供商            | 优点                            | 缺点                                   | API 密钥                                     |
| ----------------- | ------------------------------- | -------------------------------------- | -------------------------------------------- |
| **Brave**（默认） | 快速、结构化结果、有免费额度    | 传统搜索结果                           | `BRAVE_API_KEY`                              |
| **Perplexity**    | AI 综合答案、引用来源、实时搜索 | 需要 Perplexity 或 OpenRouter 访问权限 | `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY` |

有关特定提供商的详情，请参阅 [Brave Search 设置](/brave-search) 和 [Perplexity Sonar](/perplexity)。

在配置中设置提供商：

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // 或 "perplexity"
      },
    },
  },
}
```

示例：切换到 Perplexity Sonar（直连 API）：

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## 获取 Brave API 密钥

1. 在 https://brave.com/search/api/ 创建 Brave Search API 账户
2. 在控制面板中，选择 **Data for Search** 计划（不是 "Data for AI"）并生成 API 密钥。
3. 运行 `openclaw configure --section web` 将密钥存储到配置中（推荐），或在环境中设置 `BRAVE_API_KEY`。

Brave 提供免费额度和付费计划；请查看 Brave API 门户了解
当前的限制和定价。

### 密钥设置位置（推荐）

**推荐：**运行 `openclaw configure --section web`。它会将密钥存储在
`~/.openclaw/openclaw.json` 的 `tools.web.search.apiKey` 下。

**环境变量替代方案：**在 Gateway网关进程环境中设置 `BRAVE_API_KEY`。对于 Gateway网关安装，将其放入 `~/.openclaw/.env`（或你的
服务环境）。参见[环境变量](/help/faq#how-does-openclaw-load-environment-variables)。

## 使用 Perplexity（直连或通过 OpenRouter）

Perplexity Sonar 模型内置网页搜索功能，并返回带有引用来源的 AI 综合
答案。你可以通过 OpenRouter 使用它们（无需信用卡——支持
加密货币/预付费）。

### 获取 OpenRouter API 密钥

1. 在 https://openrouter.ai/ 创建账户
2. 充值（支持加密货币、预付费或信用卡）
3. 在账户设置中生成 API 密钥

### 设置 Perplexity 搜索

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API 密钥（如果已设置 OPENROUTER_API_KEY 或 PERPLEXITY_API_KEY 则可选）
          apiKey: "sk-or-v1-...",
          // 基础 URL（省略时根据密钥自动选择默认值）
          baseUrl: "https://openrouter.ai/api/v1",
          // 模型（默认为 perplexity/sonar-pro）
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**环境变量替代方案：**在 Gateway网关环境中设置 `OPENROUTER_API_KEY` 或 `PERPLEXITY_API_KEY`。对于 Gateway网关安装，将其放入 `~/.openclaw/.env`。

如果未设置基础 URL，OpenClaw 会根据 API 密钥来源选择默认值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` 或 `sk-or-...` → `https://openrouter.ai/api/v1`
- 未知密钥格式 → OpenRouter（安全回退）

### 可用的 Perplexity 模型

| 模型                             | 描述                 | 最适合   |
| -------------------------------- | -------------------- | -------- |
| `perplexity/sonar`               | 带网页搜索的快速问答 | 快速查询 |
| `perplexity/sonar-pro`（默认）   | 带网页搜索的多步推理 | 复杂问题 |
| `perplexity/sonar-reasoning-pro` | 思维链分析           | 深度研究 |

## web_search

使用你配置的提供商搜索网页。

### 前提条件

- `tools.web.search.enabled` 不能为 `false`（默认：启用）
- 你选择的提供商的 API 密钥：
  - **Brave**：`BRAVE_API_KEY` 或 `tools.web.search.apiKey`
  - **Perplexity**：`OPENROUTER_API_KEY`、`PERPLEXITY_API_KEY` 或 `tools.web.search.perplexity.apiKey`

### 配置

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // 如果已设置 BRAVE_API_KEY 则可选
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### 工具参数

- `query`（必填）
- `count`（1–10；默认从配置获取）
- `country`（可选）：用于区域特定结果的 2 字母国家代码（例如 "DE"、"US"、"ALL"）。省略时，Brave 使用其默认区域。
- `search_lang`（可选）：搜索结果的 ISO 语言代码（例如 "de"、"en"、"fr"）
- `ui_lang`（可选）：UI 元素的 ISO 语言代码
- `freshness`（可选，仅限 Brave）：按发现时间过滤（`pd`、`pw`、`pm`、`py` 或 `YYYY-MM-DDtoYYYY-MM-DD`）

**示例：**

```javascript
// 德语特定搜索
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// 法语搜索，使用法语 UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// 最近的结果（过去一周）
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

抓取 URL 并提取可读内容。

### 前提条件

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
          apiKey: "FIRECRAWL_API_KEY_HERE", // 如果已设置 FIRECRAWL_API_KEY 则可选
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

- `url`（必填，仅限 http/https）
- `extractMode`（`markdown` | `text`）
- `maxChars`（截断过长的页面）

说明：

- `web_fetch` 首先使用 Readability（主要内容提取），然后使用 Firecrawl（如果已配置）。如果两者都失败，工具返回错误。
- Firecrawl 请求使用反机器人检测模式，并默认缓存结果。
- `web_fetch` 默认发送类 Chrome 的 User-Agent 和 `Accept-Language`；如需覆盖请修改 `userAgent`。
- `web_fetch` 会阻止私有/内部主机名，并重新检查重定向（通过 `maxRedirects` 限制）。
- `web_fetch` 是尽力提取；某些网站需要使用浏览器工具。
- 有关密钥设置和服务详情，请参阅 [Firecrawl](/tools/firecrawl)。
- 响应会被缓存（默认 15 分钟）以减少重复抓取。
- 如果你使用工具配置文件/允许列表，请添加 `web_search`/`web_fetch` 或 `group:web`。
- 如果缺少 Brave 密钥，`web_search` 会返回一个简短的设置提示及文档链接。
