---
summary: "GLM 模型系列概览 + 如何在 OpenClaw 中使用它"
read_when:
  - 你想在 OpenClaw 中使用 GLM 模型
  - 你需要模型命名约定和设置方法
title: "GLM (Zhipu)"
---

# GLM 模型

GLM 是通过 Z.AI 平台提供的一个**模型系列**（不是公司）。在 OpenClaw 中，GLM 模型通过 `zai` 提供商和类似 `zai/glm-5` 的模型 ID 访问。

## 开始使用

<Steps>
  <Step title="选择认证路由并运行设置向导">
    选择与你的 Z.AI 计划和区域匹配的设置选项：

    | 认证选项 | 最适合 |
    | ----------- | -------- |
    | `zai-api-key` | 具有端点自动检测功能的通用 API 密钥设置 |
    | `zai-coding-global` | Coding Plan 用户（全球） |
    | `zai-coding-cn` | Coding Plan 用户（中国区域） |
    | `zai-global` | 通用 API（全球） |
    | `zai-cn` | 通用 API（中国区域） |

    ```bash
    # 示例：通用自动检测
    openclaw onboard --auth-choice zai-api-key

    # 示例：Coding Plan 全球
    openclaw onboard --auth-choice zai-coding-global
    ```

  </Step>
  <Step title="将 GLM 设置为默认模型">
    ```bash
    openclaw config set agents.defaults.model.primary "zai/glm-5.1"
    ```
  </Step>
  <Step title="验证模型可用">
    ```bash
    openclaw models list --provider zai
    ```
  </Step>
</Steps>

## 配置示例

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
}
```

<Tip>
`zai-api-key` 允许 OpenClaw 从密钥中检测匹配的 Z.AI 端点，并自动应用正确的基 URL。当你想要强制使用特定的 Coding Plan 或通用 API 接口时，请使用明确的区域选项。
</Tip>

## 内置 GLM 模型

OpenClaw 当前为内置的 `zai` 提供商预置了这些 GLM 引用：

| 模型 | 模型 |
| --------------- | ---------------- |
| `glm-5.1` | `glm-4.7` |
| `glm-5` | `glm-4.7-flash` |
| `glm-5-turbo` | `glm-4.7-flashx` |
| `glm-5v-turbo` | `glm-4.6` |
| `glm-4.5` | `glm-4.6v` |
| `glm-4.5-air` | |
| `glm-4.5-flash` | |
| `glm-4.5v` | |

<Note>
默认的内置模型引用是 `zai/glm-5.1`。GLM 版本和可用性可能会发生变化；请查看 Z.AI 的文档以获取最新信息。
</Note>

## 高级说明

<AccordionGroup>
  <Accordion title="端点自动检测">
    当你使用 `zai-api-key` 认证选项时，OpenClaw 会检查密钥格式以确定正确的 Z.AI 基 URL。明确的区域选项（`zai-coding-global`、`zai-coding-cn`、`zai-global`、`zai-cn`）会覆盖自动检测并直接固定端点。
  </Accordion>

  <Accordion title="提供商详情">
    GLM 模型由 `zai` 运行时提供商提供。有关完整的提供商配置、区域端点和其他功能，请参阅 [Z.AI 提供商文档](/providers/zai)。
  </Accordion>
</AccordionGroup>

## 相关内容

<CardGroup cols={2}>
  <Card title="Z.AI 提供商" href="/providers/zai" icon="server">
    完整的 Z.AI 提供商配置和区域端点。
  </Card>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
</CardGroup>
