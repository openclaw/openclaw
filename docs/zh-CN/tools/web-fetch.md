---
summary: "web_fetch 工具 — 带可读内容提取的 HTTP 获取"
read_when:
  - 您想要获取 URL 并提取可读内容
  - 您需要配置 web_fetch 或其 Firecrawl 后备
  - 您想要了解 web_fetch 限制和缓存
title: "Web Fetch"
sidebarTitle: "Web Fetch"
---

# Web Fetch

`web_fetch` 工具执行普通 HTTP GET 并提取可读内容（HTML 转换为 markdown 或文本）。它**不**执行 JavaScript。

对于 JavaScript 重度网站或登录保护页面，请改用 [Web Browser](/tools/browser)。

## 快速开始

`web_fetch` 默认**启用** — 无需配置。代理可以立即调用它：

```javascript
await web_fetch({ url: "https://example.com/article" });
```

## 工具参数

| 参数 | 类型 | 描述 |
| ------------- | -------- | ---------------------------------------- |
| `url` | `string` | 要获取的 URL（必需，仅 http/https）|
| `extractMode` | `string` | `"markdown"`（默认）或 `"text"` |
| `maxChars` | `number` | 将输出截断到此字符数 |

## 工作原理

<Steps>
  <Step title="获取">
    发送带有类 Chrome User-Agent 和 `Accept-Language` 头的 HTTP GET。阻止私有/内部主机名并重新检查重定向。
  </Step>
  <Step title="提取">
    对 HTML 响应运行 Readability（主要内容提取）。
  </Step>
  <Step title="后备（可选）">
    如果 Readability 失败且配置了 Firecrawl，通过 Firecrawl API 重试，启用机器人规避模式。
  </Step>
  <Step title="缓存">
    结果缓存 15 分钟（可配置）以减少对相同 URL 的重复获取。
  </Step>
</Steps>

## 配置

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true, // 默认：true
        maxChars: 50000, // 最大输出字符
        maxCharsCap: 50000, // maxChars 参数的硬上限
        maxResponseBytes: 2000000, // 截断前的最大下载大小
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        readability: true, // 使用 Readability 提取
        userAgent: "Mozilla/5.0 ...", // 覆盖 User-Agent
      },
    },
  },
}
```

## Firecrawl 后备

如果 Readability 提取失败，`web_fetch` 可以回退到 [Firecrawl](/tools/firecrawl) 以进行机器人规避和更好的提取：

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          enabled: true,
          apiKey: "fc-...", // 如果设置了 FIRECRAWL_API_KEY 则可选
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // 缓存持续时间（1 天）
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

`tools.web.fetch.firecrawl.apiKey` 支持 SecretRef 对象。

<Note>
  如果 Firecrawl 已启用且其 SecretRef 未解析且没有 `FIRECRAWL_API_KEY` 环境回退，则 Gateway 启动会快速失败。
</Note>

## 限制和安全

- `maxChars` 被限制为 `tools.web.fetch.maxCharsCap`
- 响应体在解析前被限制为 `maxResponseBytes`；过大的响应会截断并带有警告
- 阻止私有/内部主机名
- 重定向由 `maxRedirects` 检查和限制
- `web_fetch` 是尽力而为的 — 某些网站需要 [Web Browser](/tools/browser)

## 工具配置文件

如果您使用工具配置文件或允许列表，请添加 `web_fetch` 或 `group:web`：

```json5
{
  tools: {
    allow: ["web_fetch"],
    // 或：allow: ["group:web"]（包括 web_fetch 和 web_search）
  },
}
```

## 相关

- [网络搜索](/tools/web) — 使用多个提供商搜索网络
- [Web Browser](/tools/browser) — 适用于 JavaScript 重度网站的完整浏览器自动化
- [Firecrawl](/tools/firecrawl) — Firecrawl 搜索和抓取工具