---
summary: "通过 xAI 网络接地响应进行 Grok 网络搜索"
read_when:
  - 您想将 Grok 用于 web_search
  - 您需要 XAI_API_KEY 用于网络搜索
title: "Grok Search"
---

# Grok Search

OpenClaw 支持将 Grok 作为 `web_search` 提供商，使用 xAI 网络接地响应来产生由带引用的实时搜索结果支持的 AI 综合答案。

## 获取 API 密钥

<Steps>
  <Step title="创建密钥">
    从 [xAI](https://console.x.ai/) 获取 API 密钥。
  </Step>
  <Step title="存储密钥">
    在 Gateway 环境中设置 `XAI_API_KEY`，或通过以下方式配置：

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
      xai: {
        config: {
          webSearch: {
            apiKey: "xai-...", // 如果设置了 XAI_API_KEY 则可选
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "grok",
      },
    },
  },
}
```

**环境替代方案：** 在 Gateway 环境中设置 `XAI_API_KEY`。对于 Gateway 安装，请将其放入 `~/.openclaw/.env`。

## 工作原理

Grok 使用 xAI 网络接地响应来综合带内联引用的答案，类似于 Gemini 的 Google Search 接地方法。

## 支持的参数

Grok 搜索支持标准的 `query` 和 `count` 参数。目前不支持提供商特定的过滤器。

## 相关

- [网络搜索概述](/tools/web) — 所有提供商和自动检测
- [Gemini Search](/tools/gemini-search) — 通过 Google 接地进行 AI 综合答案