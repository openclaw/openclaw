---
read_when:
  - 你想在 OpenClaw 中使用 Together AI
  - 你需要 API 密钥环境变量或 CLI 身份验证选项
summary: Together AI 设置（身份验证 + 模型选择）
x-i18n:
  generated_at: "2026-03-16T06:27:08Z"
  model: gpt-5.4
  provider: openai
  source_hash: 4f2ba5a12b03d0140feba4f54e0540bb57237cd131c8f1d826bc3629fde2d111
  source_path: providers/together.md
  workflow: 15
---

# Together AI

[Together AI](https://together.ai) 通过统一 API 提供对领先开源模型的访问，包括 Llama、DeepSeek、Kimi 等。

- 提供商：`together`
- 身份验证：`TOGETHER_API_KEY`
- API：兼容 OpenAI

## 快速开始

1. 设置 API 密钥（推荐：为 Gateway 网关存储它）：

```bash
openclaw onboard --auth-choice together-api-key
```

2. 设置默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## 非交互式示例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

这会将 `together/moonshotai/Kimi-K2.5` 设置为默认模型。

## 环境说明

如果 Gateway 网关作为守护进程运行（launchd/systemd），请确保 `TOGETHER_API_KEY`
对该进程可用（例如在 `~/.openclaw/.env` 中，或通过
`env.shellEnv`）。

## 可用模型

Together AI 提供对许多热门开源模型的访问：

- **GLM 4.7 Fp8** - 具有 200K 上下文窗口的默认模型
- **Llama 3.3 70B Instruct Turbo** - 快速、高效的指令跟随模型
- **Llama 4 Scout** - 具备图像理解能力的视觉模型
- **Llama 4 Maverick** - 高级视觉和推理模型
- **DeepSeek V3.1** - 强大的编码和推理模型
- **DeepSeek R1** - 高级推理模型
- **Kimi K2 Instruct** - 具有 262K 上下文窗口的高性能模型

所有模型都支持标准聊天补全，并兼容 OpenAI API。
