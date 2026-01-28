---
read_when:
  - 你想使用 Brave Search 进行 web_search
  - 你需要 BRAVE_API_KEY 或套餐详情
summary: 为 web_search 设置 Brave Search API
title: Brave Search
x-i18n:
  generated_at: "2026-02-01T19:39:45Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: cdcb037b092b8a10609f02acf062b4164cb826ac22bdb3fb2909c842a1405341
  source_path: brave-search.md
  workflow: 14
---

# Brave Search API

OpenClaw 使用 Brave Search 作为 `web_search` 的默认提供商。

## 获取 API 密钥

1. 在 https://brave.com/search/api/ 创建 Brave Search API 账户。
2. 在控制面板中，选择 **Data for Search** 套餐并生成 API 密钥。
3. 将密钥存储在配置中（推荐）或在 Gateway网关环境中设置 `BRAVE_API_KEY`。

## 配置示例

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## 说明

- Data for AI 套餐与 `web_search` **不**兼容。
- Brave 提供免费套餐和付费套餐；请查看 Brave API 门户了解当前限制。

完整的 web_search 配置请参阅 [Web 工具](/tools/web)。
