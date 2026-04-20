---
summary: "使用千帆的统一 API 在 OpenClaw 中访问多个模型"
read_when:
  - 你想为多个 LLM 使用单个 API 密钥
  - 你需要百度千帆设置指导
title: "Qianfan"
---

# Qianfan

千帆是百度的 MaaS 平台，提供**统一 API**，可通过单个端点和 API 密钥将请求路由到多个模型。它是 OpenAI 兼容的，因此大多数 OpenAI SDK 只需切换基 URL 即可使用。

| 属性 | 值 |
| -------- | --------------------------------- |
| 提供商 | `qianfan` |
| 认证 | `QIANFAN_API_KEY` |
| API | OpenAI 兼容 |
| 基 URL | `https://qianfan.baidubce.com/v2` |

## 开始使用

<Steps>
  <Step title="创建百度云账户">
    在 [千帆控制台](https://console.bce.baidu.com/qianfan/ais/console/apiKey) 注册或登录，确保已启用千帆 API 访问权限。
  </Step>
  <Step title="生成 API 密钥">
    创建新应用或选择现有应用，然后生成 API 密钥。密钥格式为 `bce-v3/ALTAK-...`。
  </Step>
  <Step title="运行设置向导">
    ```bash
    openclaw onboard --auth-choice qianfan-api-key
    ```
  </Step>
  <Step title="验证模型可用">
    ```bash
    openclaw models list --provider qianfan
    ```
  </Step>
</Steps>

## 可用模型

| 模型引用 | 输入 | 上下文 | 最大输出 | 思考 | 说明 |
| ------------------------------------ | ----------- | ------- | ---------- | --------- | ------------- |
| `qianfan/deepseek-v3.2` | text | 98,304 | 32,768 | Yes | 默认模型 |
| `qianfan/ernie-5.0-thinking-preview` | text, image | 119,000 | 64,000 | Yes | 多模态 |

<Tip>
默认的内置模型引用是 `qianfan/deepseek-v3.2`。仅当你需要自定义基 URL 或模型元数据时，才需要覆盖 `models.providers.qianfan`。
</Tip>

## 配置示例

```json5
{
  env: { QIANFAN_API_KEY: "bce-v3/ALTAK-..." },
  agents: {
    defaults: {
      model: { primary: "qianfan/deepseek-v3.2" },
      models: {
        "qianfan/deepseek-v3.2": { alias: "QIANFAN" },
      },
    },
  },
  models: {
    providers: {
      qianfan: {
        baseUrl: "https://qianfan.baidubce.com/v2",
        api: "openai-completions",
        models: [
          {
            id: "deepseek-v3.2",
            name: "DEEPSEEK V3.2",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 98304,
            maxTokens: 32768,
          },
          {
            id: "ernie-5.0-thinking-preview",
            name: "ERNIE-5.0-Thinking-Preview",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 119000,
            maxTokens: 64000,
          },
        ],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="传输和兼容性">
    千帆通过 OpenAI 兼容的传输路径运行，而不是原生 OpenAI 请求整形。这意味着标准 OpenAI SDK 功能可用，但特定于提供商的参数可能不会被转发。
  </Accordion>

  <Accordion title="目录和覆盖">
    当前内置目录包括 `deepseek-v3.2` 和 `ernie-5.0-thinking-preview`。仅当你需要自定义基 URL 或模型元数据时，才添加或覆盖 `models.providers.qianfan`。

    <Note>
    模型引用使用 `qianfan/` 前缀（例如 `qianfan/deepseek-v3.2`）。
    </Note>

  </Accordion>

  <Accordion title="故障排除">
    - 确保你的 API 密钥以 `bce-v3/ALTAK-` 开头，并在百度云控制台中启用了千帆 API 访问权限。
    - 如果未列出模型，请确认你的账户已激活千帆服务。
    - 默认基 URL 为 `https://qianfan.baidubce.com/v2`。仅当使用自定义端点或代理时才更改它。
  </Accordion>
</AccordionGroup>

## 相关内容

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="配置参考" href="/gateway/configuration" icon="gear">
    完整的 OpenClaw 配置参考。
  </Card>
  <Card title="代理设置" href="/concepts/agent" icon="robot">
    配置代理默认值和模型分配。
  </Card>
  <Card title="千帆 API 文档" href="https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb" icon="arrow-up-right-from-square">
    官方千帆 API 文档。
  </Card>
</CardGroup>
