---
summary: "通过 MiniMax Coding Plan 搜索 API 进行 MiniMax 搜索"
read_when:
  - 你想使用 MiniMax 进行 web_search
  - 你需要 MiniMax Coding Plan 密钥
  - 你需要 MiniMax 中国/全球搜索主机指导
title: "MiniMax 搜索"
---

# MiniMax 搜索

OpenClaw 通过 MiniMax Coding Plan 搜索 API 支持 MiniMax 作为 `web_search` 提供商。它返回带有标题、URL、摘要和相关查询的结构化搜索结果。

## 获取 Coding Plan 密钥

<Steps>
  <Step title="创建密钥">
    从 [MiniMax 平台](https://platform.minimax.io/user-center/basic-information/interface-key) 创建或复制 MiniMax Coding Plan 密钥。
  </Step>
  <Step title="存储密钥">
    在 Gateway 环境中设置 `MINIMAX_CODE_PLAN_KEY`，或通过以下方式配置：

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

OpenClaw 也接受 `MINIMAX_CODING_API_KEY` 作为环境变量别名。当 `MINIMAX_API_KEY` 已经指向 coding-plan 令牌时，它仍然作为兼容性回退被读取。

## 配置

```json5
{
  plugins: {
    entries: {
      minimax: {
        config: {
          webSearch: {
            apiKey: "sk-cp-...", // 如果设置了 MINIMAX_CODE_PLAN_KEY，则可选
            region: "global", // 或 "cn"
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "minimax",
      },
    },
  },
}
```

**环境变量替代方案：** 在 Gateway 环境中设置 `MINIMAX_CODE_PLAN_KEY`。对于 gateway 安装，将其放在 `~/.openclaw/.env` 中。

## 区域选择

MiniMax 搜索使用以下端点：

- 全球：`https://api.minimax.io/v1/coding_plan/search`
- 中国：`https://api.minimaxi.com/v1/coding_plan/search`

如果未设置 `plugins.entries.minimax.config.webSearch.region`，OpenClaw 会按以下顺序解析区域：

1. `tools.web.search.minimax.region` / 插件拥有的 `webSearch.region`
2. `MINIMAX_API_HOST`
3. `models.providers.minimax.baseUrl`
4. `models.providers.minimax-portal.baseUrl`

这意味着中国区注册或 `MINIMAX_API_HOST=https://api.minimaxi.com/...` 会自动使 MiniMax 搜索也使用中国主机。

即使你通过 OAuth `minimax-portal` 路径验证了 MiniMax，网络搜索仍然注册为提供商 ID `minimax`；OAuth 提供商基础 URL 仅用作中国/全球主机选择的区域提示。

## 支持的参数

MiniMax 搜索支持：

- `query`
- `count`（OpenClaw 会将返回的结果列表修剪到请求的计数）

当前不支持提供商特定的过滤器。

## 相关

- [网络搜索概述](/tools/web) — 所有提供商和自动检测
- [MiniMax](/providers/minimax) — 模型、图像、语音和认证设置