---
title: "Web 搜索"
sidebarTitle: "Web 搜索"
summary: "web_search, x_search, 和 web_fetch -- 搜索网络，搜索 X 帖子，或获取页面内容"
read_when:
  - 你想启用或配置 web_search
  - 你想启用或配置 x_search
  - 你需要选择搜索提供商
  - 你想了解自动检测和提供商回退
---

# Web 搜索

`web_search` 工具使用你配置的提供商搜索网络并
返回结果。结果按查询缓存 15 分钟（可配置）。

OpenClaw 还包括用于 X（前身为 Twitter）帖子的 `x_search` 和
用于轻量级 URL 获取的 `web_fetch`。在此阶段，`web_fetch` 保持本地，而 `web_search` 和 `x_search` 可以在底层使用 xAI Responses。

<Info>
  `web_search` 是轻量级 HTTP 工具，不是浏览器自动化。对于
  JS 密集型网站或登录，请使用 [Web 浏览器](/tools/browser)。对于
  获取特定 URL，请使用 [Web Fetch](/tools/web-fetch)。
</Info>

## 快速开始

<Steps>
  <Step title="选择提供商">
    选择一个提供商并完成任何必要的设置。一些提供商
    无需密钥，而其他提供商使用 API 密钥。请参阅下面的提供商页面了解
    详细信息。
  </Step>
  <Step title="配置">
    ```bash
    openclaw configure --section web
    ```
    这会存储提供商和任何需要的凭证。你也可以设置环境
    变量（例如 `BRAVE_API_KEY`）并跳过此步骤用于 API 支持的
    提供商。
  </Step>
  <Step title="使用它">
    代理现在可以调用 `web_search`：

    ```javascript
    await web_search({ query: "OpenClaw plugin SDK" });
    ```

    对于 X 帖子，使用：

    ```javascript
    await x_search({ query: "dinner recipes" });
    ```

  </Step>
</Steps>

## 选择提供商

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    带片段的结构化结果。支持 `llm-context` 模式，国家/语言过滤器。提供免费套餐。
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    无密钥回退。无需 API 密钥。非官方基于 HTML 的集成。
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    神经 + 关键词搜索，带内容提取（亮点、文本、摘要）。
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    结构化结果。最好与 `firecrawl_search` 和 `firecrawl_scrape` 配对用于深度提取。
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    通过 Google Search 基础的 AI 合成答案，带引用。
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    通过 xAI 网络基础的 AI 合成答案，带引用。
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    通过 Moonshot 网络搜索的 AI 合成答案，带引用。
  </Card>
  <Card title="MiniMax Search" icon="globe" href="/tools/minimax-search">
    通过 MiniMax Coding Plan 搜索 API 的结构化结果。
  </Card>
  <Card title="Ollama Web Search" icon="globe" href="/tools/ollama-search">
    通过你配置的 Ollama 主机进行无密钥搜索。需要 `ollama signin`。
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    带内容提取控制和域名过滤的结构化结果。
  </Card>
  <Card title="SearXNG" icon="server" href="/tools/searxng-search">
    自托管元搜索。无需 API 密钥。聚合 Google、Bing、DuckDuckGo 等。
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    带搜索深度、主题过滤和 `tavily_extract` 用于 URL 提取的结构化结果。
  </Card>
</CardGroup>

### 提供商比较

| 提供商                                  | 结果风格               | 过滤器                                          | API 密钥                                                                          |
| ----------------------------------------- | -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| [Brave](/tools/brave-search)              | 结构化片段        | 国家、语言、时间、`llm-context` 模式      | `BRAVE_API_KEY`                                                                  |
| [DuckDuckGo](/tools/duckduckgo-search)    | 结构化片段        | --                                               | 无（无密钥）                                                                  |
| [Exa](/tools/exa-search)                  | 结构化 + 提取     | 神经/关键词模式、日期、内容提取    | `EXA_API_KEY`                                                                    |
| [Firecrawl](/tools/firecrawl)             | 结构化片段        | 通过 `firecrawl_search` 工具                      | `FIRECRAWL_API_KEY`                                                              |
| [Gemini](/tools/gemini-search)            | AI 合成 + 引用 | --                                               | `GEMINI_API_KEY`                                                                 |
| [Grok](/tools/grok-search)                | AI 合成 + 引用 | --                                               | `XAI_API_KEY`                                                                    |
| [Kimi](/tools/kimi-search)                | AI 合成 + 引用 | --                                               | `KIMI_API_KEY` / `MOONSHOT_API_KEY`                                              |
| [MiniMax Search](/tools/minimax-search)   | 结构化片段        | 区域 (`global` / `cn`)                         | `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY`                               |
| [Ollama Web Search](/tools/ollama-search) | 结构化片段        | --                                               | 默认无；需要 `ollama signin`，可重用 Ollama 提供商承载身份验证 |
| [Perplexity](/tools/perplexity-search)    | 结构化片段        | 国家、语言、时间、域名、内容限制 | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY`                                      |
| [SearXNG](/tools/searxng-search)          | 结构化片段        | 类别、语言                             | 无（自托管）                                                               |
| [Tavily](/tools/tavily)                   | 结构化片段        | 通过 `tavily_search` 工具                         | `TAVILY_API_KEY`                                                                 |

## 自动检测

## 原生 Codex 网络搜索

支持 Codex 的模型可以选择使用提供商原生的 Responses `web_search` 工具，而不是 OpenClaw 的托管 `web_search` 函数。

- 在 `tools.web.search.openaiCodex` 下配置它
- 它仅对支持 Codex 的模型激活（`openai-codex/*` 或使用 `api: "openai-codex-responses"` 的提供商）
- 托管 `web_search` 仍然适用于非 Codex 模型
- `mode: "cached"` 是默认和推荐设置
- `tools.web.search.enabled: false` 禁用托管和原生搜索

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        openaiCodex: {
          enabled: true,
          mode: "cached",
          allowedDomains: ["example.com"],
          contextSize: "high",
          userLocation: {
            country: "US",
            city: "New York",
            timezone: "America/New_York",
          },
        },
      },
    },
  },
}
```

如果启用了原生 Codex 搜索但当前模型不支持 Codex，OpenClaw 会保持正常的托管 `web_search` 行为。

## 设置网络搜索

文档和设置流程中的提供商列表按字母顺序排列。自动检测保持
单独的优先级顺序。

如果未设置 `provider`，OpenClaw 按此顺序检查提供商并使用
第一个就绪的：

首先是 API 支持的提供商：

1. **Brave** -- `BRAVE_API_KEY` 或 `plugins.entries.brave.config.webSearch.apiKey`（顺序 10）
2. **MiniMax Search** -- `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` 或 `plugins.entries.minimax.config.webSearch.apiKey`（顺序 15）
3. **Gemini** -- `GEMINI_API_KEY` 或 `plugins.entries.google.config.webSearch.apiKey`（顺序 20）
4. **Grok** -- `XAI_API_KEY` 或 `plugins.entries.xai.config.webSearch.apiKey`（顺序 30）
5. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY` 或 `plugins.entries.moonshot.config.webSearch.apiKey`（顺序 40）
6. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` 或 `plugins.entries.perplexity.config.webSearch.apiKey`（顺序 50）
7. **Firecrawl** -- `FIRECRAWL_API_KEY` 或 `plugins.entries.firecrawl.config.webSearch.apiKey`（顺序 60）
8. **Exa** -- `EXA_API_KEY` 或 `plugins.entries.exa.config.webSearch.apiKey`（顺序 65）
9. **Tavily** -- `TAVILY_API_KEY` 或 `plugins.entries.tavily.config.webSearch.apiKey`（顺序 70）

之后是无密钥回退：

10. **DuckDuckGo** -- 无密钥 HTML 回退，无需账户或 API 密钥（顺序 100）
11. **Ollama Web Search** -- 通过你配置的 Ollama 主机的无密钥回退；需要 Ollama 可访问并通过 `ollama signin` 登录，如果主机需要，可重用 Ollama 提供商承载身份验证（顺序 110）
12. **SearXNG** -- `SEARXNG_BASE_URL` 或 `plugins.entries.searxng.config.webSearch.baseUrl`（顺序 200）

如果未检测到提供商，它会回退到 Brave（你会收到一个缺少密钥的
错误，提示你配置一个）。

<Note>
  所有提供商密钥字段都支持 SecretRef 对象。在自动检测模式下，
  OpenClaw 仅解析选定的提供商密钥 -- 未选定的 SecretRefs
  保持非活动状态。
</Note>

## 配置

```json5
{
  tools: {
    web: {
      search: {
        enabled: true, // 默认：true
        provider: "brave", // 或省略以自动检测
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

提供商特定配置（API 密钥、基础 URL、模式）位于
`plugins.entries.<plugin>.config.webSearch.*` 下。请参阅提供商页面了解
示例。

`web_fetch` 回退提供商选择是分开的：

- 使用 `tools.web.fetch.provider` 选择它
- 或省略该字段，让 OpenClaw 从可用凭证中自动检测第一个就绪的 web-fetch
  提供商
- 今天捆绑的 web-fetch 提供商是 Firecrawl，配置在
  `plugins.entries.firecrawl.config.webFetch.*` 下

当你在 `openclaw onboard` 或
`openclaw configure --section web` 期间选择 **Kimi** 时，OpenClaw 还可以询问：

- Moonshot API 区域（`https://api.moonshot.ai/v1` 或 `https://api.moonshot.cn/v1`）
- 默认 Kimi 网络搜索模型（默认为 `kimi-k2.5`）

对于 `x_search`，配置 `plugins.entries.xai.config.xSearch.*`。它使用
与 Grok 网络搜索相同的 `XAI_API_KEY` 回退。
旧的 `tools.web.x_search.*` 配置由 `openclaw doctor --fix` 自动迁移。
当你在 `openclaw onboard` 或 `openclaw configure --section web` 期间选择 Grok 时，
OpenClaw 也可以提供使用相同密钥的可选 `x_search` 设置。
这是 Grok 路径内的单独后续步骤，不是单独的顶级
网络搜索提供商选择。如果你选择其他提供商，OpenClaw 不会
显示 `x_search` 提示。

### 存储 API 密钥

<Tabs>
  <Tab title="配置文件">
    运行 `openclaw configure --section web` 或直接设置密钥：

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "YOUR_KEY", // pragma: allowlist secret
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="环境变量">
    在 Gateway 进程环境中设置提供商环境变量：

    ```bash
    export BRAVE_API_KEY="YOUR_KEY"
    ```

    对于网关安装，将其放在 `~/.openclaw/.env` 中。
    请参阅 [环境变量](/help/faq#env-vars-and-env-loading)。

  </Tab>
</Tabs>

## 工具参数

| 参数             | 描述                                           |
| --------------------- | ----------------------------------------------------- |
| `query`               | 搜索查询（必需）                               |
| `count`               | 返回的结果数（1-10，默认：5）                  |
| `country`             | 2 字母 ISO 国家代码（例如 "US"、"DE"）           |
| `language`            | ISO 639-1 语言代码（例如 "en"、"de"）             |
| `search_lang`         | 搜索语言代码（仅 Brave）                     |
| `freshness`           | 时间过滤器：`day`、`week`、`month` 或 `year`        |
| `date_after`          | 此日期之后的结果（YYYY-MM-DD）                  |
| `date_before`         | 此日期之前的结果（YYYY-MM-DD）                 |
| `ui_lang`             | UI 语言代码（仅 Brave）                         |
| `domain_filter`       | 域名允许列表/拒绝列表数组（仅 Perplexity）     |
| `max_tokens`          | 总内容预算，默认 25000（仅 Perplexity） |
| `max_tokens_per_page` | 每页令牌限制，默认 2048（仅 Perplexity）  |

<Warning>
  并非所有参数都适用于所有提供商。Brave `llm-context` 模式
  拒绝 `ui_lang`、`freshness`、`date_after` 和 `date_before`。
  Gemini、Grok 和 Kimi 返回一个带引用的合成答案。它们
  接受 `count` 以实现共享工具兼容性，但它不会改变
  基础答案形状。
  当你使用 Sonar/OpenRouter
  兼容路径（`plugins.entries.perplexity.config.webSearch.baseUrl` /
  `model` 或 `OPENROUTER_API_KEY`）时，Perplexity 行为相同。
  SearXNG 仅接受 `http://` 用于受信任的专用网络或环回主机；
  公共 SearXNG 端点必须使用 `https://`。
  Firecrawl 和 Tavily 通过 `web_search` 仅支持 `query` 和 `count`
  -- 使用它们的专用工具获取高级选项。
</Warning>

## x_search

`x_search` 使用 xAI 查询 X（前身为 Twitter）帖子并返回
带引用的 AI 合成答案。它接受自然语言查询和
可选的结构化过滤器。OpenClaw 仅在为该工具调用提供服务的请求上启用内置的 xAI `x_search`
工具。

<Note>
  xAI 文档说明 `x_search` 支持关键词搜索、语义搜索、用户
  搜索和线程获取。对于每帖子参与统计，如转发、
  回复、书签或视图，优先使用针对确切帖子 URL
  或状态 ID 的目标查找。广泛的关键词搜索可能会找到正确的帖子，但返回较少
  完整的每帖子元数据。一个好的模式是：首先定位帖子，然后
  运行第二个专注于该确切帖子的 `x_search` 查询。
</Note>

### x_search 配置

```json5
{
  plugins: {
    entries: {
      xai: {
        config: {
          xSearch: {
            enabled: true,
            model: "grok-4-1-fast-non-reasoning",
            inlineCitations: false,
            maxTurns: 2,
            timeoutSeconds: 30,
            cacheTtlMinutes: 15,
          },
          webSearch: {
            apiKey: "xai-...", // 如果设置了 XAI_API_KEY，则可选
          },
        },
      },
    },
  },
}
```

### x_search 参数

| 参数                    | 描述                                            |
| ---------------------------- | ------------------------------------------------------ |
| `query`                      | 搜索查询（必需）                                |
| `allowed_x_handles`          | 将结果限制为特定 X 句柄                 |
| `excluded_x_handles`         | 排除特定 X 句柄                             |
| `from_date`                  | 仅包含此日期或之后的帖子（YYYY-MM-DD）  |
| `to_date`                    | 仅包含此日期或之前的帖子（YYYY-MM-DD） |
| `enable_image_understanding` | 让 xAI 检查附加到匹配帖子的图像      |
| `enable_video_understanding` | 让 xAI 检查附加到匹配帖子的视频      |

### x_search 示例

```javascript
await x_search({
  query: "dinner recipes",
  allowed_x_handles: ["nytfood"],
  from_date: "2026-03-01",
});
```

```javascript
// 每帖子统计：尽可能使用确切的状态 URL 或状态 ID
await x_search({
  query: "https://x.com/huntharo/status/1905678901234567890",
});
```

## 示例

```javascript
// 基本搜索
await web_search({ query: "OpenClaw plugin SDK" });

// 德国特定搜索
await web_search({ query: "TV online schauen", country: "DE", language: "de" });

// 最近结果（过去一周）
await web_search({ query: "AI developments", freshness: "week" });

// 日期范围
await web_search({
  query: "climate research",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// 域名过滤（仅 Perplexity）
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});
```

## 工具配置文件

如果你使用工具配置文件或允许列表，添加 `web_search`、`x_search` 或 `group:web`：

```json5
{
  tools: {
    allow: ["web_search", "x_search"],
    // 或：allow: ["group:web"] （包括 web_search、x_search 和 web_fetch）
  },
}
```

## 相关

- [Web Fetch](/tools/web-fetch) -- 获取 URL 并提取可读内容
- [Web 浏览器](/tools/browser) -- 用于 JS 密集型网站的完整浏览器自动化
- [Grok 搜索](/tools/grok-search) -- 作为 `web_search` 提供商的 Grok
- [Ollama Web 搜索](/tools/ollama-search) -- 通过你的 Ollama 主机进行无密钥网络搜索