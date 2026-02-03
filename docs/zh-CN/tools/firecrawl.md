---
read_when:
  - 你需要基于 Firecrawl 的网页提取
  - 你需要 Firecrawl API 密钥
  - 你需要为 web_fetch 提供反爬虫提取功能
summary: Firecrawl 作为 web_fetch 的备用方案（反爬虫 + 缓存提取）
title: Firecrawl
x-i18n:
  generated_at: "2026-02-01T21:42:22Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 08a7ad45b41af41204e44d2b0be0f980b7184d80d2fa3977339e42a47beb2851
  source_path: tools/firecrawl.md
  workflow: 15
---

# Firecrawl

OpenClaw 可以使用 **Firecrawl** 作为 `web_fetch` 的备用提取器。它是一个托管的内容提取服务，支持反爬虫绕过和缓存，有助于处理 JS 密集型网站或阻止普通 HTTP 请求的页面。

## 获取 API 密钥

1. 创建 Firecrawl 账户并生成 API 密钥。
2. 将其存储在配置中，或在 Gateway网关环境中设置 `FIRECRAWL_API_KEY`。

## 配置 Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

注意事项：

- 当存在 API 密钥时，`firecrawl.enabled` 默认为 true。
- `maxAgeMs` 控制缓存结果的最大有效时长（毫秒）。默认为 2 天。

## 隐身/反爬虫绕过

Firecrawl 提供了一个用于反爬虫绕过的**代理模式**参数（`basic`、`stealth` 或 `auto`）。
OpenClaw 对 Firecrawl 请求始终使用 `proxy: "auto"` 加上 `storeInCache: true`。
如果省略 proxy，Firecrawl 默认使用 `auto`。`auto` 模式在基本尝试失败后会使用隐身代理重试，这可能比仅使用基本模式的抓取消耗更多积分。

## `web_fetch` 如何使用 Firecrawl

`web_fetch` 提取顺序：

1. Readability（本地）
2. Firecrawl（如已配置）
3. 基本 HTML 清理（最终备用方案）

参阅[网页工具](/tools/web)了解全部网页工具设置。
