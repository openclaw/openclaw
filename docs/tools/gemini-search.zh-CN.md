---
summary: "使用 Google Search 基础的 Gemini 网络搜索"
read_when:
  - 你想要使用 Gemini 进行 web_search
  - 你需要 GEMINI_API_KEY
  - 你想要 Google Search 基础
title: "Gemini 搜索"
---

# Gemini 搜索

OpenClaw 支持带有内置
[Google Search 基础](https://ai.google.dev/gemini-api/docs/grounding) 的 Gemini 模型，
它返回由实时 Google Search 结果支持的 AI 合成答案，并带有
引用。

## 获取 API 密钥

<Steps>
  <Step title="创建密钥">
    前往 [Google AI Studio](https://aistudio.google.com/apikey) 并创建一个
    API 密钥。
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
            apiKey: "AIza...", // 如果设置了 GEMINI_API_KEY，则可选
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

**环境替代方案：** 在 Gateway 环境中设置 `GEMINI_API_KEY`。
对于网关安装，将其放在 `~/.openclaw/.env` 中。

## 工作原理

与返回链接和摘要列表的传统搜索提供者不同，
Gemini 使用 Google Search 基础来生成带有
内联引用的 AI 合成答案。结果包括合成答案和来源
URL。

- 来自 Gemini 基础的引用 URL 会自动从 Google
  重定向 URL 解析为直接 URL。
- 重定向解析在返回最终引用 URL 之前使用 SSRF 保护路径（HEAD + 重定向检查 +
  http/https 验证）。
- 重定向解析使用严格的 SSRF 默认设置，因此重定向到
  私有/内部目标会被阻止。

## 支持的参数

Gemini 搜索支持 `query`。

为了共享 `web_search` 兼容性，`count` 被接受，但 Gemini 基础
仍然返回一个带有引用的合成答案，而不是 N 结果
列表。

不支持特定于提供者的过滤器，如 `country`、`language`、`freshness` 和
`domain_filter`。

## 模型选择

默认模型是 `gemini-2.5-flash`（快速且具有成本效益）。任何支持基础的 Gemini
模型都可以通过
`plugins.entries.google.config.webSearch.model` 使用。

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Brave 搜索](/tools/brave-search) -- 带有摘要的结构化结果
- [Perplexity 搜索](/tools/perplexity-search) -- 结构化结果 + 内容提取