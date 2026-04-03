---
summary: "通过 Moonshot 网络搜索使用 Kimi 进行网络搜索"
read_when:
  - 您想将 Kimi 用于 web_search
  - 您需要 KIMI_API_KEY 或 MOONSHOT_API_KEY
title: "Kimi Search"
---

# Kimi Search

OpenClaw 支持将 Kimi 作为 `web_search` 提供商，使用 Moonshot 网络搜索来产生带有引用的 AI 综合答案。

## 获取 API 密钥

<Steps>
  <Step title="创建密钥">
    从 [Moonshot AI](https://platform.moonshot.cn/) 获取 API 密钥。
  </Step>
  <Step title="存储密钥">
    在 Gateway 环境中设置 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`，或通过以下方式配置：

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
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // 如果设置了 KIMI_API_KEY 或 MOONSHOT_API_KEY 则可选
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

**环境替代方案：** 在 Gateway 环境中设置 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`。对于 Gateway 安装，请将其放入 `~/.openclaw/.env`。

## 工作原理

Kimi 使用 Moonshot 网络搜索来产生带有内联引用的综合答案，类似于 Gemini 和 Grok 的接地响应方法。

## 支持的参数

Kimi 搜索支持标准的 `query` 和 `count` 参数。目前不支持提供商特定的过滤器。

## 相关

- [网络搜索概述](/tools/web) — 所有提供商和自动检测
- [Gemini Search](/tools/gemini-search) — 通过 Google 接地进行 AI 综合答案
- [Grok Search](/tools/grok-search) — 通过 xAI 接地进行 AI 综合答案