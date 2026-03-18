---
summary: "通过 AIsa 在 OpenClaw 中使用中国顶级 AI 模型"
read_when:
  - 你想在 OpenClaw 中使用中国 AI 模型（通义千问、Kimi、GLM、DeepSeek、MiniMax）
  - 你需要配置 AISA_API_KEY
title: "AIsa"
---

# AIsa

[AIsa](https://marketplace.aisa.one/) 提供统一的 OpenAI 兼容网关，通过 `https://api.aisa.one/v1` 访问中国顶级 AI 模型。一个 API 密钥即可使用通义千问、Kimi、GLM、DeepSeek、MiniMax 等模型。

## 可用模型

| 模型 | 开发商 | 输入 $/1M | 输出 $/1M | 上下文 | 视觉 | 推理 |
|---|---|---|---|---|---|---|
| `minimax-m2.1` | MiniMax | $0.21 | $0.84 | 200k | — | — |
| `seed-1-8-251228` | 字节跳动 | $0.225 | $1.80 | 128k | — | ✓ |
| `deepseek-v3.2` | DeepSeek | $0.28 | $0.42 | 128k | — | ✓ |
| `kimi-k2.5`（默认） | 月之暗面 | $0.40 | $2.11 | 256k | — | ✓ |
| `qwen3-max` | 阿里巴巴 | $0.72 | $3.60 | 256k | ✓ | ✓ |
| `glm-5` | 智谱 AI | $1.00 | $3.20 | 200k | ✓ | ✓ |

## 命令行设置

```bash
export AISA_API_KEY="sk-..."
openclaw onboard --auth-choice aisa-api-key
```

或非交互式：

```bash
openclaw onboard --aisa-api-key "sk-..."
```

然后设置默认模型：

```bash
openclaw models set aisa/kimi-k2.5
```

## 配置示例

```json5
{
  env: { AISA_API_KEY: "sk-..." },
  models: {
    "aisa/kimi-k2.5": { alias: "AIsa" }
  }
}
```

## 获取 API 密钥

前往 [marketplace.aisa.one](https://marketplace.aisa.one/) 注册获取 API 密钥。
