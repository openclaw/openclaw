---
summary: "DuckDuckGo 网络搜索 — 无需密钥的后备提供商（实验性，基于 HTML）"
read_when:
  - 您想要一个不需要 API 密钥的网络搜索提供商
  - 您想将 DuckDuckGo 用于 web_search
  - 您需要一个零配置搜索后备
title: "DuckDuckGo Search"
---

# DuckDuckGo Search

OpenClaw 支持将 DuckDuckGo 作为**无需密钥**的 `web_search` 提供商。无需 API 密钥或账户。

<Warning>
  DuckDuckGo 是一个**实验性、非官方**的集成，从 DuckDuckGo 的非 JavaScript 搜索页面获取结果 — 不是官方 API。预期可能会因为机器人挑战页面或 HTML 更改而偶尔出现故障。
</Warning>

## 设置

无需 API 密钥 — 只需将 DuckDuckGo 设置为您的提供商：

<Steps>
  <Step title="配置">
    ```bash
    openclaw configure --section web
    # 选择 "duckduckgo" 作为提供商
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

区域和安全搜索的可选插件级设置：

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

| 参数 | 描述 |
| ------------ | ---------------------------------------------------------- |
| `query` | 搜索查询（必需）|
| `count` | 返回结果数（1-10，默认：5）|
| `region` | DuckDuckGo 区域代码（例如 `us-en`、`uk-en`、`de-de`）|
| `safeSearch` | 安全搜索级别：`strict`、`moderate`（默认）或 `off` |

区域和安全搜索也可以在插件配置中设置（见上文）— 每次查询的工具参数会覆盖配置值。

## 备注

- **无需 API 密钥** — 开箱即用，零配置
- **实验性** — 从 DuckDuckGo 的非 JavaScript HTML 搜索页面收集结果，不是官方 API 或 SDK
- **机器人挑战风险** — DuckDuckGo 可能会在重度或自动化使用下提供 CAPTCHA 或阻止请求
- **HTML 解析** — 结果取决于页面结构，可能会随时更改
- **自动检测顺序** — DuckDuckGo 在自动检测中最后被检查（顺序 100），因此任何带有密钥的 API 支持的提供商优先
- **未配置时安全搜索默认为 moderate**

<Tip>
  对于生产使用，请考虑 [Brave Search](/tools/brave-search)（有免费套餐可用）或其他 API 支持的提供商。
</Tip>

## 相关

- [网络搜索概述](/tools/web) — 所有提供商和自动检测
- [Brave Search](/tools/brave-search) — 带免费套餐的结构化结果
- [Exa Search](/tools/exa-search) — 带内容提取的神经搜索