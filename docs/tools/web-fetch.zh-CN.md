---
summary: "web_fetch 工具 -- 带可读内容提取的 HTTP 获取"
read_when:
  - 您希望获取 URL 并提取可读内容
  - 您需要配置 web_fetch 或其 Firecrawl 回退
  - 您希望了解 web_fetch 限制和缓存
title: "网络获取"
sidebarTitle: "网络获取"
---

# 网络获取

`web_fetch` 工具执行普通的 HTTP GET 并提取可读内容（HTML 转 markdown 或文本）。它**不**执行 JavaScript。

对于 JS 密集型站点或受登录保护的页面，请改用 [Web 浏览器](/tools/browser)。

## 快速开始

`web_fetch` **默认启用** -- 无需配置。代理可以立即调用它：

```javascript
await web_fetch({ url: "https://example.com/article" });
```

## 工具参数

| 参数 | 类型 | 描述 |
| --- | --- | --- |
| `url` | `string` | 要获取的 URL（必需，仅 http/https） |
| `extractMode` | `string` | `"markdown"`（默认）或 `"text"` |
| `maxChars` | `number` | 将输出截断到此字符数 |

## 工作原理

<Steps>
  <Step title="获取">
    发送带有类 Chrome User-Agent 和 `Accept-Language` 标头的 HTTP GET。阻止私有/内部主机名并重新检查重定向。
  </Step>
  <Step title="提取">
    对 HTML 响应运行 Readability（主要内容提取）。
  </Step>
  <Step title="回退（可选）">
    如果 Readability 失败且配置了 Firecrawl，则通过 Firecrawl API 以机器人规避模式重试。
  </Step>
  <Step title="缓存">
    结果缓存 15 分钟（可配置），以减少对同一 URL 的重复获取。
  </Step>
</Steps>

## 配置

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true, // 默认：true
        provider: "firecrawl", // 可选；省略以自动检测
        maxChars: 50000, // 最大输出字符数
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

## Firecrawl 回退

如果 Readability 提取失败，`web_fetch` 可以回退到 [Firecrawl](/tools/firecrawl) 进行机器人规避和更好的提取：

```json5
{
  tools: {
    web: {
      fetch: {
        provider: "firecrawl", // 可选；省略以从可用凭据自动检测
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webFetch: {
            apiKey: "fc-...", // 如果设置了 FIRECRAWL_API_KEY，则可选
            baseUrl: "https://api.firecrawl.dev",
            onlyMainContent: true,
            maxAgeMs: 86400000, // 缓存持续时间（1 天）
            timeoutSeconds: 60,
          },
        },
      },
    },
  },
}
```

`plugins.entries.firecrawl.config.webFetch.apiKey` 支持 SecretRef 对象。
旧版 `tools.web.fetch.firecrawl.*` 配置由 `openclaw doctor --fix` 自动迁移。

<Note>
  如果 Firecrawl 已启用且其 SecretRef 未解析且没有 `FIRECRAWL_API_KEY` 环境回退，网关启动会快速失败。
</Note>

<Note>
  Firecrawl `baseUrl` 覆盖被锁定：它们必须使用 `https://` 和官方 Firecrawl 主机 (`api.firecrawl.dev`)。
</Note>

当前运行时行为：

- `tools.web.fetch.provider` 显式选择获取回退提供者。
- 如果省略 `provider`，OpenClaw 会从可用凭据自动检测第一个就绪的网络获取提供者。今天的捆绑提供者是 Firecrawl。
- 如果禁用了 Readability，`web_fetch` 会直接跳转到选定的提供者回退。如果没有可用的提供者，它会关闭失败。

## 限制和安全

- `maxChars` 被限制为 `tools.web.fetch.maxCharsCap`
- 响应体在解析前被限制为 `maxResponseBytes`；超大响应会被截断并显示警告
- 私有/内部主机名被阻止
- 重定向被检查并受 `maxRedirects` 限制
- `web_fetch` 是尽力而为的 -- 某些站点需要 [Web 浏览器](/tools/browser)

## 工具配置文件

如果您使用工具配置文件或允许列表，请添加 `web_fetch` 或 `group:web`：

```json5
{
  tools: {
    allow: ["web_fetch"],
    // 或：allow: ["group:web"] （包括 web_fetch、web_search 和 x_search）
  },
}
```

## 相关

- [网络搜索](/tools/web) -- 使用多个提供者搜索网络
- [Web 浏览器](/tools/browser) -- 针对 JS 密集型站点的完整浏览器自动化
- [Firecrawl](/tools/firecrawl) -- Firecrawl 搜索和抓取工具