---
summary: "在 OpenClaw 中使用 Z.AI（GLM 模型）"
read_when:
  - 你想在 OpenClaw 中使用 Z.AI / GLM 模型
  - 你需要简单的 ZAI_API_KEY 设置
title: "Z.AI"
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它为 GLM 提供 REST API，并使用 API 密钥进行身份验证。在 Z.AI 控制台中创建你的 API 密钥。OpenClaw 使用带有 Z.AI API 密钥的 `zai` 提供商。

- 提供商：`zai`
- 认证：`ZAI_API_KEY`
- API：Z.AI Chat Completions（Bearer 认证）

## 开始使用

<Tabs>
  <Tab title="自动检测端点">
    **最适合：**大多数用户。OpenClaw 从密钥中检测匹配的 Z.AI 端点，并自动应用正确的基 URL。

    <Steps>
      <Step title="运行设置向导">
        ```bash
        openclaw onboard --auth-choice zai-api-key
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          env: { ZAI_API_KEY: "sk-..." },
          agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider zai
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="明确的区域端点">
    **最适合：**想要强制使用特定 Coding Plan 或通用 API 接口的用户。

    <Steps>
      <Step title="选择正确的设置选项">
        ```bash
        # Coding Plan 全球（推荐给 Coding Plan 用户）
        openclaw onboard --auth-choice zai-coding-global

        # Coding Plan CN（中国区域）
        openclaw onboard --auth-choice zai-coding-cn

        # 通用 API
        openclaw onboard --auth-choice zai-global

        # 通用 API CN（中国区域）
        openclaw onboard --auth-choice zai-cn
        ```
      </Step>
      <Step title="设置默认模型">
        ```json5
        {
          env: { ZAI_API_KEY: "sk-..." },
          agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
        }
        ```
      </Step>
      <Step title="验证模型可用">
        ```bash
        openclaw models list --provider zai
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## 内置 GLM 目录

OpenClaw 当前为内置的 `zai` 提供商预置了：

| 模型引用 | 说明 |
| -------------------- | ------------- |
| `zai/glm-5.1` | 默认模型 |
| `zai/glm-5` | |
| `zai/glm-5-turbo` | |
| `zai/glm-5v-turbo` | |
| `zai/glm-4.7` | |
| `zai/glm-4.7-flash` | |
| `zai/glm-4.7-flashx` | |
| `zai/glm-4.6` | |
| `zai/glm-4.6v` | |
| `zai/glm-4.5` | |
| `zai/glm-4.5-air` | |
| `zai/glm-4.5-flash` | |
| `zai/glm-4.5v` | |

<Tip>
GLM 模型以 `zai/<model>` 形式提供（例如：`zai/glm-5`）。默认的内置模型引用是 `zai/glm-5.1`。
</Tip>

## 高级配置

<AccordionGroup>
  <Accordion title="前向解析未知的 GLM-5 模型">
    当 ID 匹配当前 GLM-5 系列格式时，未知的 `glm-5*` ID 仍然可以通过从 `glm-4.7` 模板合成提供商拥有的元数据，在内置提供商路径上进行前向解析。
  </Accordion>

  <Accordion title="工具调用流式传输">
    Z.AI 的工具调用流式传输默认启用 `tool_stream`。要禁用它：

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "zai/<model>": {
              params: { tool_stream: false },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="图像理解">
    内置的 Z.AI 插件会注册图像理解功能。

    | 属性 | 值 |
    | ------------- | ----------- |
    | 模型 | `glm-4.6v` |

    图像理解功能会自动从配置的 Z.AI 认证中解析——无需额外配置。

  </Accordion>

  <Accordion title="认证详情">
    - Z.AI 使用带有你的 API 密钥的 Bearer 认证。
    - `zai-api-key` 设置选项会从密钥前缀自动检测匹配的 Z.AI 端点。
    - 当你想要强制使用特定 API 接口时，请使用明确的区域选项（`zai-coding-global`、`zai-coding-cn`、`zai-global`、`zai-cn`）。
  </Accordion>
</AccordionGroup>

## 相关内容

<CardGroup cols={2}>
  <Card title="GLM 模型系列" href="/providers/glm" icon="microchip">
    GLM 的模型系列概览。
  </Card>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
</CardGroup>
