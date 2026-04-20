---
title: "Volcengine (Doubao)"
summary: "火山引擎设置（豆包模型，通用+编程端点）"
read_when:
  - 你想在 OpenClaw 中使用火山引擎或豆包模型
  - 你需要火山引擎 API 密钥设置
---

# Volcengine (Doubao)

火山引擎提供商可访问豆包模型和托管在火山引擎上的第三方模型，为通用和编程工作负载提供单独的端点。

| 详情 | 值 |
| --------- | --------------------------------------------------- |
| 提供商 | `volcengine`（通用）+ `volcengine-plan`（编程） |
| 认证 | `VOLCANO_ENGINE_API_KEY` |
| API | OpenAI 兼容 |

## 开始使用

<Steps>
  <Step title="设置 API 密钥">
    运行交互式设置：

    ```bash
    openclaw onboard --auth-choice volcengine-api-key
    ```

    这会从单个 API 密钥同时注册通用（`volcengine`）和编程（`volcengine-plan`）提供商。

  </Step>
  <Step title="设置默认模型">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "volcengine-plan/ark-code-latest" },
        },
      },
    }
    ```
  </Step>
  <Step title="验证模型可用">
    ```bash
    openclaw models list --provider volcengine
    openclaw models list --provider volcengine-plan
    ```
  </Step>
</Steps>

<Tip>
对于非交互式设置（CI、脚本），直接传递密钥：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

</Tip>

## 提供商和端点

| 提供商 | 端点 | 用例 |
| ----------------- | ----------------------------------------- | -------------- |
| `volcengine` | `ark.cn-beijing.volces.com/api/v3` | 通用模型 |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | 编程模型 |

<Note>
两个提供商都从单个 API 密钥配置。设置会自动注册两者。
</Note>

## 可用模型

<Tabs>
  <Tab title="通用（volcengine）">
    | 模型引用 | 名称 | 输入 | 上下文 |
    | -------------------------------------------- | ------------------------------- | ----------- | ------- |
    | `volcengine/doubao-seed-1-8-251228` | Doubao Seed 1.8 | text, image | 256,000 |
    | `volcengine/doubao-seed-code-preview-251028` | doubao-seed-code-preview-251028 | text, image | 256,000 |
    | `volcengine/kimi-k2-5-260127` | Kimi K2.5 | text, image | 256,000 |
    | `volcengine/glm-4-7-251222` | GLM 4.7 | text, image | 200,000 |
    | `volcengine/deepseek-v3-2-251201` | DeepSeek V3.2 | text, image | 128,000 |
  </Tab>
  <Tab title="编程（volcengine-plan）">
    | 模型引用 | 名称 | 输入 | 上下文 |
    | ------------------------------------------------- | ------------------------ | ----- | ------- |
    | `volcengine-plan/ark-code-latest` | Ark Coding Plan | text | 256,000 |
    | `volcengine-plan/doubao-seed-code` | Doubao Seed Code | text | 256,000 |
    | `volcengine-plan/glm-4.7` | GLM 4.7 Coding | text | 200,000 |
    | `volcengine-plan/kimi-k2-thinking` | Kimi K2 Thinking | text | 256,000 |
    | `volcengine-plan/kimi-k2.5` | Kimi K2.5 Coding | text | 256,000 |
    | `volcengine-plan/doubao-seed-code-preview-251028` | Doubao Seed Code Preview | text | 256,000 |
  </Tab>
</Tabs>

## 高级说明

<AccordionGroup>
  <Accordion title="设置后的默认模型">
    `openclaw onboard --auth-choice volcengine-api-key` 当前会将 `volcengine-plan/ark-code-latest` 设置为默认模型，同时也会注册通用的 `volcengine` 目录。
  </Accordion>

  <Accordion title="模型选择器回退行为">
    在设置/配置模型选择期间，火山引擎认证选择会同时优先考虑 `volcengine/*` 和 `volcengine-plan/*` 行。如果这些模型尚未加载，OpenClaw 会回退到未过滤的目录，而不是显示空的提供商范围选择器。
  </Accordion>

  <Accordion title="守护进程的环境变量">
    如果网关作为守护进程（launchd/systemd）运行，请确保 `VOLCANO_ENGINE_API_KEY` 对该进程可用（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。
  </Accordion>
</AccordionGroup>

<Warning>
当将 OpenClaw 作为后台服务运行时，在交互式 shell 中设置的环境变量不会自动继承。请参阅上面的守护进程说明。
</Warning>

## 相关内容

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="配置" href="/configuration" icon="gear">
    代理、模型和提供商的完整配置参考。
  </Card>
  <Card title="故障排除" href="/help/troubleshooting" icon="wrench">
    常见问题和调试步骤。
  </Card>
  <Card title="常见问题" href="/help/faq" icon="circle-question">
    关于 OpenClaw 设置的常见问题。
  </Card>
</CardGroup>
