---
title: "Groq"
summary: "Groq 设置（认证 + 模型选择）"
read_when:
  - 你想在 OpenClaw 中使用 Groq
  - 你需要 API 密钥环境变量或 CLI 认证选项
---

# Groq

[Groq](https://groq.com) 使用自定义 LPU 硬件在开源模型（Llama、Gemma、Mistral 等）上提供超快速推理。OpenClaw 通过其 OpenAI 兼容的 API 连接到 Groq。

| 属性   | 值                |
| ------ | ----------------- |
| 提供商 | `groq`            |
| 认证   | `GROQ_API_KEY`    |
| API    | OpenAI 兼容       |

## 入门指南

<Steps>
  <Step title="获取 API 密钥">
    在 [console.groq.com/keys](https://console.groq.com/keys) 创建 API 密钥。
  </Step>
  <Step title="设置 API 密钥">
    ```bash
    export GROQ_API_KEY="gsk_..."
    ```
  </Step>
  <Step title="设置默认模型">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "groq/llama-3.3-70b-versatile" },
        },
      },
    }
    ```
  </Step>
</Steps>

### 配置文件示例

```json5
{
  env: { GROQ_API_KEY: "gsk_..." },
  agents: {
    defaults: {
      model: { primary: "groq/llama-3.3-70b-versatile" },
    },
  },
}
```

## 可用模型

Groq 的模型目录经常变化。运行 `openclaw models list | grep groq` 查看当前可用的模型，或检查 [console.groq.com/docs/models](https://console.groq.com/docs/models)。

| 模型                       | 说明                              |
| --------------------------- | ---------------------------------- |
| **Llama 3.3 70B Versatile** | 通用型，大上下文                  |
| **Llama 3.1 8B Instant**    | 快速，轻量级                      |
| **Gemma 2 9B**              | 紧凑，高效                        |
| **Mixtral 8x7B**            | MoE 架构，强大的推理能力          |

<Tip>
使用 `openclaw models list --provider groq` 获取你账户上可用的最新模型列表。
</Tip>

## 音频转录

Groq 还提供基于 Whisper 的快速音频转录。当配置为媒体理解提供商时，OpenClaw 使用 Groq 的 `whisper-large-v3-turbo` 模型通过共享的 `tools.media.audio` 接口转录语音消息。

```json5
{
  tools: {
    media: {
      audio: {
        models: [{ provider: "groq" }],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="音频转录详情">
    | 属性 | 值 |
    |------|-------|
    | 共享配置路径 | `tools.media.audio` |
    | 默认基础 URL | `https://api.groq.com/openai/v1` |
    | 默认模型 | `whisper-large-v3-turbo` |
    | API 端点 | OpenAI 兼容的 `/audio/transcriptions` |
  </Accordion>

  <Accordion title="环境说明">
    如果网关作为守护进程运行（launchd/systemd），请确保 `GROQ_API_KEY` 对该进程可用（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。

    <Warning>
    仅在交互式 shell 中设置的密钥对守护进程管理的网关进程不可见。使用 `~/.openclaw/.env` 或 `env.shellEnv` 配置以获得持久可用性。
    </Warning>

  </Accordion>
</AccordionGroup>

## 相关

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="配置参考" href="/gateway/configuration-reference" icon="gear">
    完整的配置架构，包括提供商和音频设置。
  </Card>
  <Card title="Groq 控制台" href="https://console.groq.com" icon="arrow-up-right-from-square">
    Groq 仪表板、API 文档和定价。
  </Card>
  <Card title="Groq 模型列表" href="https://console.groq.com/docs/models" icon="list">
    官方 Groq 模型目录。
  </Card>
</CardGroup>