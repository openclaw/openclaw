---
title: "DeepSeek"
summary: "DeepSeek 设置（认证 + 模型选择）"
read_when:
  - 你想在 OpenClaw 中使用 DeepSeek
  - 你需要 API 密钥环境变量或 CLI 认证选项
---

# DeepSeek

[DeepSeek](https://www.deepseek.com) 提供具有 OpenAI 兼容 API 的强大 AI 模型。

| 属性 | 值 |
| -------- | -------------------------- |
| 提供商 | `deepseek` |
| 认证 | `DEEPSEEK_API_KEY` |
| API | OpenAI 兼容 |
| 基 URL | `https://api.deepseek.com` |

## 开始使用

<Steps>
  <Step title="获取你的 API 密钥">
    在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 创建 API 密钥。
  </Step>
  <Step title="运行设置向导">
    ```bash
    openclaw onboard --auth-choice deepseek-api-key
    ```

    这会提示输入你的 API 密钥，并将 `deepseek/deepseek-chat` 设置为默认模型。

  </Step>
  <Step title="验证模型可用">
    ```bash
    openclaw models list --provider deepseek
    ```
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="非交互式设置">
    对于脚本化或无人值守安装，直接传递所有标志：

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice deepseek-api-key \
      --deepseek-api-key "$DEEPSEEK_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
如果网关作为守护进程（launchd/systemd）运行，请确保该进程可以访问 `DEEPSEEK_API_KEY`（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。
</Warning>

## 内置目录

| 模型引用 | 名称 | 输入 | 上下文 | 最大输出 | 说明 |
| ---------------------------- | ----------------- | ----- | ------- | ---------- | ------------------------------------------------- |
| `deepseek/deepseek-chat` | DeepSeek Chat | text | 131,072 | 8,192 | 默认模型；DeepSeek V3.2 非思考接口 |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner | text | 131,072 | 65,536 | 启用思考的 V3.2 接口 |

<Tip>
当前两个内置模型在源代码中都宣传了流式使用兼容性。
</Tip>

## 配置示例

```json5
{
  env: { DEEPSEEK_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-chat" },
    },
  },
}
```

## 相关内容

<CardGroup cols={2}>
  <Card title="模型选择" href="/concepts/model-providers" icon="layers">
    选择提供商、模型引用和故障转移行为。
  </Card>
  <Card title="配置参考" href="/gateway/configuration-reference" icon="gear">
    代理、模型和提供商的完整配置参考。
  </Card>
</CardGroup>
