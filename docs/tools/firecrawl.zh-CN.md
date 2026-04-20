---
summary: "Firecrawl 搜索、抓取和 web_fetch 回退"
read_when:
  - 你想要 Firecrawl 支持的网络提取
  - 你需要 Firecrawl API 密钥
  - 你想要 Firecrawl 作为 web_search 提供者
  - 你想要为 web_fetch 提供反机器人提取
title: "Firecrawl"
---

# Firecrawl

OpenClaw 可以通过三种方式使用 **Firecrawl**：

- 作为 `web_search` 提供者
- 作为显式插件工具：`firecrawl_search` 和 `firecrawl_scrape`
- 作为 `web_fetch` 的回退提取器

它是一个托管的提取/搜索服务，支持机器人规避和缓存，
这有助于处理 JS 密集型网站或阻止普通 HTTP 获取的页面。

## 获取 API 密钥

1. 创建 Firecrawl 账户并生成 API 密钥。
2. 将其存储在配置中或在网关环境中设置 `FIRECRAWL_API_KEY`。

## 配置 Firecrawl 搜索

```json5
{
  tools: {
    web: {
      search: {
        provider: "firecrawl",
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "FIRECRAWL_API_KEY_HERE",
            baseUrl: "https://api.firecrawl.dev",
          },
        },
      },
    },
  },
}
```

注意：

- 在入职或 `openclaw configure --section web` 中选择 Firecrawl 会自动启用捆绑的 Firecrawl 插件。
- 使用 Firecrawl 的 `web_search` 支持 `query` 和 `count`。
- 对于 Firecrawl 特定的控制，如 `sources`、`categories` 或结果抓取，请使用 `firecrawl_search`。
- `baseUrl` 覆盖必须保持在 `https://api.firecrawl.dev`。
- `FIRECRAWL_BASE_URL` 是 Firecrawl 搜索和抓取基础 URL 的共享环境回退。

## 配置 Firecrawl 抓取 + web_fetch 回退

```json5
{
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webFetch: {
            apiKey: "FIRECRAWL_API_KEY_HERE",
            baseUrl: "https://api.firecrawl.dev",
            onlyMainContent: true,
            maxAgeMs: 172800000,
            timeoutSeconds: 60,
          },
        },
      },
    },
  },
}
```

注意：

- 仅当 API 密钥可用时（`plugins.entries.firecrawl.config.webFetch.apiKey` 或 `FIRECRAWL_API_KEY`），才会运行 Firecrawl 回退尝试。
- `maxAgeMs` 控制缓存结果的最大年龄（毫秒）。默认值为 2 天。
- 旧的 `tools.web.fetch.firecrawl.*` 配置由 `openclaw doctor --fix` 自动迁移。
- Firecrawl 抓取/基础 URL 覆盖仅限于 `https://api.firecrawl.dev`。

`firecrawl_scrape` 重用相同的 `plugins.entries.firecrawl.config.webFetch.*` 设置和环境变量。

## Firecrawl 插件工具

### `firecrawl_search`

当你想要 Firecrawl 特定的搜索控制而不是通用的 `web_search` 时使用此工具。

核心参数：

- `query`
- `count`
- `sources`
- `categories`
- `scrapeResults`
- `timeoutSeconds`

### `firecrawl_scrape`

用于普通 `web_fetch` 较弱的 JS 密集型或受机器人保护的页面。

核心参数：

- `url`
- `extractMode`
- `maxChars`
- `onlyMainContent`
- `maxAgeMs`
- `proxy`
- `storeInCache`
- `timeoutSeconds`

## 隐身 / 机器人规避

Firecrawl 为机器人规避公开了一个 **代理模式** 参数（`basic`、`stealth` 或 `auto`）。
OpenClaw 始终对 Firecrawl 请求使用 `proxy: "auto"` 加 `storeInCache: true`。
如果省略代理，Firecrawl 默认为 `auto`。`auto` 如果基本尝试失败，会使用隐身代理重试，这可能会使用更多积分
比仅基本抓取。

## `web_fetch` 如何使用 Firecrawl

`web_fetch` 提取顺序：

1. 可读性（本地）
2. Firecrawl（如果选择或自动检测为活动的 web-fetch 回退）
3. 基本 HTML 清理（最后的回退）

选择旋钮是 `tools.web.fetch.provider`。如果你省略它，OpenClaw
从可用凭证中自动检测第一个就绪的 web-fetch 提供者。
今天的捆绑提供者是 Firecrawl。

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [网络获取](/tools/web-fetch) -- 带有 Firecrawl 回退的 web_fetch 工具
- [Tavily](/tools/tavily) -- 搜索 + 提取工具