---
summary: "SearXNG 网络搜索 — 自托管、无密钥的元搜索引擎"
read_when:
  - 你想要一个自托管的网络搜索提供者
  - 你想要使用 SearXNG 进行 web_search
  - 你需要注重隐私或气隙搜索选项
title: "SearXNG 搜索"
---

# SearXNG 搜索

OpenClaw 支持 [SearXNG](https://docs.searxng.org/) 作为**自托管、无密钥**的 `web_search` 提供者。SearXNG 是一个开源元搜索引擎，聚合来自 Google、Bing、DuckDuckGo 和其他来源的结果。

优势：

- **免费且无限** -- 无需 API 密钥或商业订阅
- **隐私 / 气隙** -- 查询永远不会离开你的网络
- **随处可用** -- 对商业搜索 API 没有区域限制

## 设置

<Steps>
  <Step title="运行 SearXNG 实例">
    ```bash
    docker run -d -p 8888:8080 searxng/searxng
    ```

    或者使用你可以访问的任何现有 SearXNG 部署。有关生产设置，请参阅 [SearXNG 文档](https://docs.searxng.org/)。

  </Step>
  <Step title="配置">
    ```bash
    openclaw configure --section web
    # 选择 "searxng" 作为提供者
    ```

    或者设置环境变量并让自动检测找到它：

    ```bash
    export SEARXNG_BASE_URL="http://localhost:8888"
    ```

  </Step>
</Steps>

## 配置

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
      },
    },
  },
}
```

SearXNG 实例的插件级设置：

```json5
{
  plugins: {
    entries: {
      searxng: {
        config: {
          webSearch: {
            baseUrl: "http://localhost:8888",
            categories: "general,news", // 可选
            language: "en", // 可选
          },
        },
      },
    },
  },
}
```

`baseUrl` 字段也接受 SecretRef 对象。

传输规则：

- `https://` 适用于公共或私有 SearXNG 主机
- `http://` 仅接受受信任的专用网络或环回主机
- 公共 SearXNG 主机必须使用 `https://`

## 环境变量

设置 `SEARXNG_BASE_URL` 作为配置的替代方案：

```bash
export SEARXNG_BASE_URL="http://localhost:8888"
```

当设置了 `SEARXNG_BASE_URL` 且未配置显式提供者时，自动检测会自动选择 SearXNG（优先级最低 — 任何带有密钥的 API 支持的提供者首先获胜）。

## 插件配置参考

| 字段         | 描述                                              |
| ------------ | ------------------------------------------------- |
| `baseUrl`    | 你的 SearXNG 实例的基础 URL（必需）               |
| `categories` | 逗号分隔的类别，如 `general`、`news` 或 `science` |
| `language`   | 结果的语言代码，如 `en`、`de` 或 `fr`             |

## 注意事项

- **JSON API** -- 使用 SearXNG 的原生 `format=json` 端点，不是 HTML 抓取
- **无 API 密钥** -- 开箱即可与任何 SearXNG 实例一起使用
- **基础 URL 验证** -- `baseUrl` 必须是有效的 `http://` 或 `https://`
  URL；公共主机必须使用 `https://`
- **自动检测顺序** -- SearXNG 在自动检测中最后检查（顺序 200）。
  配置了密钥的 API 支持的提供者首先运行，然后是 DuckDuckGo（顺序 100），然后是 Ollama Web Search（顺序 110）
- **自托管** -- 你控制实例、查询和上游搜索引擎
- **类别** 未配置时默认为 `general`

<Tip>
  为了使 SearXNG JSON API 工作，请确保你的 SearXNG 实例在其 `settings.yml` 的 `search.formats` 下启用了 `json` 格式。
</Tip>

## 相关

- [网络搜索概述](/tools/web) -- 所有提供者和自动检测
- [DuckDuckGo 搜索](/tools/duckduckgo-search) -- 另一个无密钥回退
- [Brave 搜索](/tools/brave-search) -- 带有免费层级的结构化结果
