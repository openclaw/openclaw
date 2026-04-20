---
summary: "通过 Moonshot 网络搜索进行 Kimi 网络搜索"
read_when:
  - 你想要使用 Kimi 进行 web_search
  - 你需要 KIMI_API_KEY 或 MOONSHOT_API_KEY
title: "Kimi 搜索"
---

# Kimi 搜索

OpenClaw 支持将 Kimi 作为 `web_search` 提供者，使用 Moonshot 网络搜索
生成带有引用的 AI 合成答案。

## 获取 API 密钥

<Steps>
  <Step title="创建密钥">
    从 [Moonshot AI](https://platform.moonshot.cn/) 获取 API 密钥。
  </Step>
  <Step title="存储密钥">
    在 Gateway 环境中设置 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`，或
    通过以下方式配置：

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

当你在 `openclaw onboard` 或
`openclaw configure --section web` 期间选择 **Kimi** 时，OpenClaw 还可以询问：

- Moonshot API 区域：
  - `https://api.moonshot.ai/v1`
  - `https://api.moonshot.cn/v1`
- 默认 Kimi 网络搜索模型（默认为 `kimi-k2.5`）

## 配置

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // 如果设置了 KIMI_API_KEY 或 MOONSHOT_API_KEY，则可选
            baseUrl: "https://api.moonshot.ai/v1",
            model: "kimi-k2.5",
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

如果你使用中国 API 主机进行聊天（`models.providers.moonshot.baseUrl`：
`https://api.moonshot.cn/v1`），当省略 `tools.web.search.kimi.baseUrl` 时，OpenClaw 会为 Kimi
`web_search` 重用同一个主机，因此来自
[platform.moonshot.cn](https://platform.moonshot.cn/) 的密钥不会错误地访问
国际端点（这通常会返回 HTTP 401）。当你需要不同的搜索基础 URL 时，使用 `tools.web.search.kimi.baseUrl` 覆盖。

**环境替代方案：** 在 Gateway 环境中设置 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`。
对于网关安装，将其放在 `~/.openclaw/.env` 中。

如果你省略 `baseUrl`，OpenClaw 默认为 `https://api.moonshot.ai/v1`。
如果你省略 `model`，OpenClaw 默认为 `kimi-k2.5`。

## 工作原理

Kimi 使用 Moonshot 网络搜索来合成带有内联引用的答案，
类似于 Gemini 和 Grok 的基础响应方法。

## 支持的参数

Kimi 搜索支持 `query`。

为了共享 `web_search` 兼容性，`count` 被接受，但 Kimi 仍然
返回一个带有引用的合成答案，而不是 N 结果列表。

当前不支持特定于提供者的过滤器。

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Moonshot AI](/providers/moonshot) -- Moonshot 模型 + Kimi 编码提供者文档
- [Gemini 搜索](/tools/gemini-search) -- 通过 Google 基础的 AI 合成答案
- [Grok 搜索](/tools/grok-search) -- 通过 xAI 基础的 AI 合成答案