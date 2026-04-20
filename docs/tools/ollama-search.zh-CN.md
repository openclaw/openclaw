---
summary: "通过配置的 Ollama 主机进行 Ollama 网络搜索"
read_when:
  - 你想要使用 Ollama 进行 web_search
  - 你想要一个无需密钥的 web_search 提供者
  - 你需要 Ollama Web Search 设置指南
title: "Ollama 网络搜索"
---

# Ollama 网络搜索

OpenClaw 支持 **Ollama Web Search** 作为捆绑的 `web_search` 提供者。
它使用 Ollama 的实验性网络搜索 API 并返回带有标题、URL 和片段的结构化结果。

与 Ollama 模型提供者不同，此设置默认不需要 API 密钥。它需要：

- 一个可从 OpenClaw 访问的 Ollama 主机
- `ollama signin`

## 设置

<Steps>
  <Step title="启动 Ollama">
    确保 Ollama 已安装并正在运行。
  </Step>
  <Step title="登录">
    运行：

    ```bash
    ollama signin
    ```

  </Step>
  <Step title="选择 Ollama Web Search">
    运行：

    ```bash
    openclaw configure --section web
    ```

    然后选择 **Ollama Web Search** 作为提供者。

  </Step>
</Steps>

如果你已经使用 Ollama 进行模型，Ollama Web Search 会重用相同的配置主机。

## 配置

```json5
{
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

可选的 Ollama 主机覆盖：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
      },
    },
  },
}
```

如果未设置明确的 Ollama 基础 URL，OpenClaw 使用 `http://127.0.0.1:11434`。

如果你的 Ollama 主机需要 bearer 认证，OpenClaw 也会为网络搜索请求重用 `models.providers.ollama.apiKey`（或匹配的环境支持的提供者认证）。

## 注意事项

- 此提供者不需要特定于网络搜索的 API 密钥字段。
- 如果 Ollama 主机受认证保护，OpenClaw 会在存在时重用正常的 Ollama 提供者 API 密钥。
- 如果 Ollama 无法访问或未登录，OpenClaw 会在设置期间发出警告，但不会阻止选择。
- 当没有配置更高优先级的凭证提供者时，运行时自动检测可以回退到 Ollama Web Search。
- 提供者使用 Ollama 的实验性 `/api/experimental/web_search` 端点。

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [Ollama](/providers/ollama) -- Ollama 模型设置和云/本地模式