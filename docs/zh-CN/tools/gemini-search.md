---
summary: "带有 Google Search 接地的 Gemini 网络搜索"
read_when:
  - 您想将 Gemini 用于 web_search
  - 您需要 GEMINI_API_KEY
  - 您想要 Google Search 接地
title: "Gemini Search"
---

# Gemini Search

OpenClaw 支持带有内置 [Google Search 接地](https://ai.google.dev/gemini-api/docs/grounding) 的 Gemini 模型，它返回由实时 Google 搜索结果支持的带有引用的 AI 综合答案。

## 获取 API 密钥

<Steps>
  <Step title="创建密钥">
    转到 [Google AI Studio](https://aistudio.google.com/apikey) 创建 API 密钥。
  </Step>
  <Step title="存储密钥">
    在 Gateway 环境中设置 `GEMINI_API_KEY`，或通过以下方式配置：

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## 配置

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // 如果设置了 GEMINI_API_KEY 则可选
            model: "gemini-2.5-flash", // 默认
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "gemini",
      },
    },
  },
}
```

**环境替代方案：** 在 Gateway 环境中设置 `GEMINI_API_KEY`。对于 Gateway 安装，请将其放入 `~/.openclaw/.env`。

## 工作原理

与返回链接和片段列表的传统搜索提供商不同，Gemini 使用 Google Search 接地来产生带有内联引用的 AI 综合答案。结果包括综合答案和来源 URL。

- Gemini 接地中的引用 URL 会自动从 Google 重定向 URL 解析为直接 URL。
- 重定向解析在返回最终引用 URL 之前使用 SSRF 保护路径（HEAD + 重定向检查 + http/https 验证）。
- 重定向解析使用严格的 SSRF 默认值，因此到私有/内部目标的重定向被阻止。

## 支持的参数

Gemini 搜索支持标准的 `query` 和 `count` 参数。不支持 `country`、`language`、`freshness` 和 `domain_filter` 等特定于提供商的过滤器。

## 模型选择

默认模型是 `gemini-2.5-flash`（快速且经济）。任何支持接地功能的 Gemini 模型都可以通过 `plugins.entries.google.config.webSearch.model` 使用。

## 相关

- [网络搜索概述](/tools/web) — 所有提供商和自动检测
- [Brave Search](/tools/brave-search) — 带片段的结构化结果
- [Perplexity Search](/tools/perplexity-search) — 结构化结果 + 内容提取