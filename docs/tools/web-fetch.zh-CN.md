---
summary: "web_fetch 工具 -- 带可读内容提取的 HTTP 获取"
read_when:
  - 你想获取 URL 并提取可读内容
  - 你需要配置 web_fetch 或其 Firecrawl 回退
  - 你想了解 web_fetch 的限制和缓存

title: "Web Fetch"
sidebarTitle: "Web Fetch"
---

# Web Fetch

`web_fetch` 工具执行普通的 HTTP GET 并提取可读内容
（HTML 转 markdown 或文本）。它**不**执行 JavaScript。

对于 JS 密集型网站或登录保护的页面，请使用
[Web 浏览器](/tools/browser) 代替。

## 快速开始

`web_fetch` **默认启用** -- 无需配置。代理可以
立即调用它：

```javascript
await web_fetch({ url: "https://example.com/article" });
```

## 工具参数

| 参数     | 类型     | 描述                              |
| ------------- | -------- | ---------------------------------------- |
| `url`         | `string` | 要获取的 URL（必需，仅 http/https） |
| `extractMode` | `string` | `"markdown"`（默认）或 `"text"`       |
| `maxChars`    | `number` | 将输出截断到这么多字符       |

## 它如何工作

<Steps>
  <Step title="获取">
    发送带有类 Chrome User-Agent 和 `Accept-Language`
    头的 HTTP GET。阻止私有/内部主机名并重新检查重定向。
  </Step>
  <Step title="提取">
    对 HTML 响应运行 Readability（主要内容提取）。
  </Step>
  <Step title="回退（可选）">
    如果 Readability 失败且配置了 Firecrawl，通过
    Firecrawl API 重试，启用机器人规避模式。
  </Step>
  <Step title="缓存">
    结果缓存 15 分钟（可配置），以减少对同一 URL 的重复
    获取。
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

如果 Readability 提取失败，`web_fetch` 可以回退到
[Firecrawl](/tools/firecrawl) 进行机器人规避和更好的提取：

```json5
{
  tools: {
    web: {
      fetch: {
        provider: "firecrawl", // 可选；省略以从可用凭证自动检测
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
旧的 `tools.web.fetch.firecrawl.*` 配置由 `openclaw doctor --fix` 自动迁移。

<Note>
  如果启用了 Firecrawl 且其 SecretRef 未解析且没有
  `FIRECRAWL_API_KEY` 环境回退，网关启动会快速失败。
</Note>

<Note>
  Firecrawl `baseUrl` 覆盖被锁定：它们必须使用 `https://` 和
  官方 Firecrawl 主机（`api.firecrawl.dev`）。
</Note>

当前运行时行为：

- `tools.web.fetch.provider` 显式选择获取回退提供商。
- 如果省略 `provider`，OpenClaw 从可用凭证中自动检测第一个就绪的 web-fetch
  提供商。今天捆绑的提供商是 Firecrawl。
- 如果 Readability 被禁用，`web_fetch` 直接跳转到选定的
  提供商回退。如果没有可用的提供商，它会关闭失败。

## 限制和安全

- `maxChars` 被限制为 `tools.web.fetch.maxCharsCap`
- 响应体在解析前被限制为 `maxResponseBytes`；超大
  响应会被截断并显示警告
- 私有/内部主机名被阻止
- 重定向被检查并受 `maxRedirects` 限制
- `web_fetch` 是尽力而为的 -- 有些网站需要 [Web 浏览器](/tools/browser)

## 工具配置文件

如果你使用工具配置文件或允许列表，添加 `web_fetch` 或 `group:web`：

```json5
{
  tools: {
    allow: ["web_fetch"],
    // 或：allow: ["group:web"] （包括 web_fetch、web_search 和 x_search）
  },
}
```

## 相关

- [Web 搜索](/tools/web) -- 使用多个提供商搜索网络
- [Web 浏览器](/tools/browser) -- 用于 JS 密集型网站的完整浏览器自动化
- [Firecrawl](/tools/firecrawl) -- Firecrawl 搜索和抓取工具