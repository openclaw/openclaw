---
summary: "通过 Baidu AppBuilder 为 web_search 提供智能搜索生成"
read_when:
  - 你想用百度作为 web_search 提供商
  - 你需要配置 APPBUILDER_API_KEY
  - 你希望获得带引用的百度搜索综合答案
title: "Baidu Search"
x-i18n:
  generated_at: "2026-03-28T00:00:00Z"
  model: manual
  provider: codex
  source_path: tools/baidu-search.md
---

# Baidu Search

OpenClaw 支持把 Baidu AppBuilder 作为 `web_search` 提供商，调用其“智能搜索生成”
接口，返回基于百度实时搜索结果综合生成的答案，并附带引用来源。

## 获取 API Key

<Steps>
  <Step title="创建密钥">
    在 [Baidu AppBuilder](https://appbuilder.baidu.com/) 中创建 AppBuilder
    API key。
  </Step>
  <Step title="保存密钥">
    在 Gateway 环境中设置 `APPBUILDER_API_KEY`，或者运行：

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## 配置示例

```json5
{
  plugins: {
    entries: {
      baidu: {
        config: {
          webSearch: {
            apiKey: "appbuilder_...", // 如果已设置 APPBUILDER_API_KEY 可省略
            model: "ernie-4.5-turbo-32k", // 默认值
            enableDeepSearch: false, // 可选
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "baidu",
      },
    },
  },
}
```

**环境变量方式：** 设置 `APPBUILDER_API_KEY`。历史兼容场景下也接受
`APPBUILDER_TOKEN`。对于 Gateway 安装，可放进 `~/.openclaw/.env`。

## 工作方式

OpenClaw 通过 Baidu AppBuilder 的 `chat/completions` AI Search API，并固定使用
`baidu_search_v2` 作为检索源，让模型基于实时网页结果生成综合回答。

- `count` 会映射到 Baidu 的 `resource_type_filter`
- `freshness` 会映射到 `search_recency_filter`
  支持的取值为 `week`、`month`、`semiyear`、`year`
- `date_after` / `date_before` 会映射到网页发布时间范围过滤
- `country` 与 `language` 暂不支持

## 支持的参数

支持：

- `query`
- `count`
- `freshness`
- `date_after`
- `date_before`

不支持：

- `country`
- `language`
- Brave `ui_lang`、Perplexity `domain_filter` 这类提供商专属参数

## 相关文档

- [Web Search 概览](/tools/web)
- [Gemini Search](/tools/gemini-search)
- [Kimi Search](/tools/kimi-search)
