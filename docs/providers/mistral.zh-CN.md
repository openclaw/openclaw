---
summary: "在 OpenClaw 中使用 Mistral 模型和 Voxtral 转录"
read_when:
  - 你想在 OpenClaw 中使用 Mistral 模型
  - 你需要 Mistral API 密钥引导设置和模型引用
title: "Mistral"
---

# Mistral

OpenClaw 支持 Mistral 用于文本/图像模型路由（`mistral/...`）和通过媒体理解中的 Voxtral 进行音频转录。
Mistral 还可用于记忆嵌入（`memorySearch.provider = "mistral"`）。

- 提供商：`mistral`
- 认证：`MISTRAL_API_KEY`
- API：Mistral 聊天完成（`https://api.mistral.ai/v1`）

## 入门指南

<Steps>
  <Step title="获取你的 API 密钥">
    在 [Mistral 控制台](https://console.mistral.ai/) 中创建 API 密钥。
  </Step>
  <Step title="运行引导设置">
    ```bash
    openclaw onboard --auth-choice mistral-api-key
    ```

    或者直接传递密钥：

    ```bash
    openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
    ```

  </Step>
  <Step title="设置默认模型">
    ```json5
    {
      env: { MISTRAL_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
    }
    ```
  </Step>
  <Step title="验证模型可用">
    ```bash
    openclaw models list --provider mistral
    ```
  </Step>
</Steps>

## 内置 LLM 目录

OpenClaw 目前提供以下捆绑的 Mistral 目录：

| 模型引用                        | 输入       | 上下文   | 最大输出  | 说明                                                            |
| ------------------------------- | ---------- | -------- | --------- | --------------------------------------------------------------- |
| `mistral/mistral-large-latest`   | 文本，图像 | 262,144  | 16,384    | 默认模型                                                        |
| `mistral/mistral-medium-2508`    | 文本，图像 | 262,144  | 8,192     | Mistral Medium 3.1                                               |
| `mistral/mistral-small-latest`   | 文本，图像 | 128,000  | 16,384    | Mistral Small 4；通过 API `reasoning_effort` 可调整推理         |
| `mistral/pixtral-large-latest`   | 文本，图像 | 128,000  | 32,768    | Pixtral                                                          |
| `mistral/codestral-latest`       | 文本       | 256,000  | 4,096     | 编码                                                           |
| `mistral/devstral-medium-latest` | 文本       | 262,144  | 32,768    | Devstral 2                                                       |
| `mistral/magistral-small`        | 文本       | 128,000  | 40,000    | 启用推理                                                        |

## 音频转录（Voxtral）

通过媒体理解管道使用 Voxtral 进行音频转录。

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

<Tip>
媒体转录路径使用 `/v1/audio/transcriptions`。Mistral 的默认音频模型是 `voxtral-mini-latest`。
</Tip>

## 高级配置

<AccordionGroup>
  <Accordion title="可调整推理（mistral-small-latest）">
    `mistral/mistral-small-latest` 映射到 Mistral Small 4，并通过 `reasoning_effort` 支持 Chat Completions API 上的[可调整推理](https://docs.mistral.ai/capabilities/reasoning/adjustable)（`none` 最小化输出中的额外思考；`high` 在最终答案前显示完整的思考轨迹）。

    OpenClaw 将会话**思考**级别映射到 Mistral 的 API：

    | OpenClaw 思考级别                          | Mistral `reasoning_effort` |
    | ------------------------------------------ | -------------------------- |
    | **off** / **minimal**                      | `none`                     |
    | **low** / **medium** / **high** / **xhigh** / **adaptive** | `high`             |

    <Note>
    其他捆绑的 Mistral 目录模型不使用此参数。当你想要 Mistral 的原生推理优先行为时，请继续使用 `magistral-*` 模型。
    </Note>

  </Accordion>

  <Accordion title="记忆嵌入">
    Mistral 可以通过 `/v1/embeddings` 提供记忆嵌入（默认模型：`mistral-embed`）。

    ```json5
    {
      memorySearch: { provider: "mistral" },
    }
    ```

  </Accordion>

  <Accordion title="认证和基础 URL">
    - Mistral 认证使用 `MISTRAL_API_KEY`。
    - 提供商基础 URL 默认为 `https://api.mistral.ai/v1`。
    - 引导设置的默认模型是 `mistral/mistral-large-latest`。
    - Z.AI 使用你的 API 密钥进行 Bearer 认证。
  </Accordion>
</AccordionGroup>

## 相关

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="媒体理解" href="/tools/media-understanding" icon="microphone">
    音频转录设置和提供商选择。
  </Card>
</CardGroup>