---
summary: "DuckDuckGo 网络搜索 -- 无密钥回退提供者（实验性，基于HTML）"
read_when:
  - 你想要一个不需要API密钥的网络搜索提供者
  - 你想要使用DuckDuckGo进行web_search
  - 你需要零配置的搜索回退
title: "DuckDuckGo 搜索"
---

# DuckDuckGo 搜索

OpenClaw 支持将 DuckDuckGo 作为**无密钥**的 `web_search` 提供者。不需要 API 密钥或账户。

<Warning>
  DuckDuckGo 是一个**实验性、非官方**的集成，它从 DuckDuckGo 的非 JavaScript 搜索页面获取结果 — 不是官方 API。由于机器人挑战页面或 HTML 变化，可能会偶尔出现故障。
</Warning>

## 设置

不需要 API 密钥 — 只需将 DuckDuckGo 设置为你的提供者：

<Steps>
  <Step title="配置">
    ```bash
    openclaw configure --section web
    # 选择 "duckduckgo" 作为提供者
    ```
  </Step>
</Steps>

## 配置

```json5
{
  tools: {
    web: {
      search: {
        provider: "duckduckgo",
      },
    },
  },
}
```

区域和安全搜索的可选插件级别设置：

```json5
{
  plugins: {
    entries: {
      duckduckgo: {
        config: {
          webSearch: {
            region: "us-en", // DuckDuckGo 区域代码
            safeSearch: "moderate", // "strict"、"moderate" 或 "off"
          },
        },
      },
    },
  },
}
```

## 工具参数

| 参数         | 描述                                                  |
| ------------ | ---------------------------------------------------- |
| `query`      | 搜索查询（必需）                                      |
| `count`      | 返回结果数（1-10，默认：5）                           |
| `region`     | DuckDuckGo 区域代码（例如 `us-en`、`uk-en`、`de-de`） |
| `safeSearch` | 安全搜索级别：`strict`、`moderate`（默认）或 `off`    |

区域和安全搜索也可以在插件配置中设置（见上文）— 工具参数会覆盖每个查询的配置值。

## 注意

- **无 API 密钥** — 开箱即用，零配置
- **实验性** — 从 DuckDuckGo 的非 JavaScript HTML 搜索页面收集结果，不是官方 API 或 SDK
- **机器人挑战风险** — 在大量或自动化使用下，DuckDuckGo 可能会提供 CAPTCHA 或阻止请求
- **HTML 解析** — 结果依赖于页面结构，可能会在没有通知的情况下更改
- **自动检测顺序** — DuckDuckGo 是自动检测中的第一个无密钥回退（顺序 100）。配置了密钥的 API 支持的提供者首先运行，然后是 Ollama Web Search（顺序 110），然后是 SearXNG（顺序 200）
- **安全搜索默认为中等**（未配置时）

<Tip>
  对于生产使用，考虑 [Brave Search](/tools/brave-search)（提供免费层级）或其他 API 支持的提供者。
</Tip>

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Brave Search](/tools/brave-search) -- 带有免费层级的结构化结果
- [Exa Search](/tools/exa-search) -- 带有内容提取的神经搜索