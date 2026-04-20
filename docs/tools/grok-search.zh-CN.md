---
summary: "通过 xAI 网络基础响应进行 Grok 网络搜索"
read_when:
  - 你想要使用 Grok 进行 web_search
  - 你需要 XAI_API_KEY 进行网络搜索
title: "Grok 搜索"
---

# Grok 搜索

OpenClaw 支持将 Grok 作为 `web_search` 提供者，使用 xAI 网络基础
响应生成由实时搜索结果支持的 AI 合成答案，
并带有引用。

同一个 `XAI_API_KEY` 也可以为内置的 `x_search` 工具提供支持，用于 X
（前身为 Twitter）帖子搜索。如果你将密钥存储在
`plugins.entries.xai.config.webSearch.apiKey` 下，OpenClaw 现在也会将其重用为
捆绑的 xAI 模型提供者的回退。

对于帖子级别的 X 指标，如转发、回复、书签或浏览量，首选
`x_search` 并使用确切的帖子 URL 或状态 ID，而不是广泛的搜索
查询。

## 入职和配置

如果你在以下过程中选择 **Grok**：

- `openclaw onboard`
- `openclaw configure --section web`

OpenClaw 可以显示一个单独的后续步骤，使用相同的
`XAI_API_KEY` 启用 `x_search`。该后续步骤：

- 仅在你选择 Grok 作为 `web_search` 后出现
- 不是单独的顶级网络搜索提供者选择
- 可以在同一流程中选择设置 `x_search` 模型

如果你跳过它，可以稍后在配置中启用或更改 `x_search`。

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
            apiKey: "xai-...", // 如果设置了 XAI_API_KEY，则可选
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

**环境替代方案：** 在 Gateway 环境中设置 `XAI_API_KEY`。
对于网关安装，将其放在 `~/.openclaw/.env` 中。

## 工作原理

Grok 使用 xAI 网络基础响应来合成带有内联
引用的答案，类似于 Gemini 的 Google Search 基础方法。

## 支持的参数

Grok 搜索支持 `query`。

为了共享 `web_search` 兼容性，`count` 被接受，但 Grok 仍然
返回一个带有引用的合成答案，而不是 N 结果列表。

当前不支持特定于提供者的过滤器。

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Web Search 中的 x_search](/tools/web#x_search) -- 通过 xAI 进行一流的 X 搜索
- [Gemini 搜索](/tools/gemini-search) -- 通过 Google 基础的 AI 合成答案