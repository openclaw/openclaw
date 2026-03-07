---
read_when:
  - 你想使用 Perplexity Sonar 进行网络搜索
  - 你需要设置 PERPLEXITY_API_KEY 或 OpenRouter
summary: Perplexity Sonar 的 web_search 设置
title: Perplexity Sonar
x-i18n:
  generated_at: "2026-02-01T21:19:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 264d08e62e3bec854e378dad345ca209d139cd19b0469f3b25f88bb63b73ba00
  source_path: perplexity.md
  workflow: 15
---

# Perplexity Sonar

OpenClaw 可以使用 Perplexity Sonar 作为 `web_search` 工具。你可以通过 Perplexity 的直连 API 或通过 OpenRouter 连接。

## API 选项

### Perplexity（直连）

- Base URL：https://api.perplexity.ai
- 环境变量：`PERPLEXITY_API_KEY`

### OpenRouter（替代方案）

- Base URL：https://openrouter.ai/api/v1
- 环境变量：`OPENROUTER_API_KEY`
- 支持预付费/加密货币积分。

## 配置示例

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## 从 Brave 切换

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
        },
      },
    },
  },
}
```

如果同时设置了 `PERPLEXITY_API_KEY` 和 `OPENROUTER_API_KEY`，请设置 `tools.web.search.perplexity.baseUrl`（或 `tools.web.search.perplexity.apiKey`）以消除歧义。

如果未设置 base URL，OpenClaw 会根据 API 密钥来源选择默认值：

- `PERPLEXITY_API_KEY` 或 `pplx-...` → 直连 Perplexity（`https://api.perplexity.ai`）
- `OPENROUTER_API_KEY` 或 `sk-or-...` → OpenRouter（`https://openrouter.ai/api/v1`）
- 未知密钥格式 → OpenRouter（安全回退）

## 模型

- `perplexity/sonar` — 带网络搜索的快速问答
- `perplexity/sonar-pro`（默认） — 多步推理 + 网络搜索
- `perplexity/sonar-reasoning-pro` — 深度研究

请参阅 [Web 工具](/tools/web) 了解 web_search 配置详情。
