---
title: "Volcengine (Doubao)"
summary: "火山引擎设置（Doubao 模型、通用和编码端点）"
read_when:
  - 您想将火山引擎或 Doubao 模型与 OpenClaw 一起使用
  - 您需要 Volcengine API 密钥设置
---

# Volcengine (Doubao)

Volcengine 提供商提供对 Doubao 模型和托管在火山引擎上的第三方模型的访问，通用和编码工作负载使用单独的端点。

- 提供商：`volcengine`（通用）+ `volcengine-plan`（编码）
- 认证：`VOLCANO_ENGINE_API_KEY`
- API：OpenAI 兼容

## 快速开始

1. 设置 API 密钥：

```bash
openclaw onboard --auth-choice volcengine-api-key
```

2. 设置默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "volcengine-plan/ark-code-latest" },
    },
  },
}
```

## 非交互示例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

## 提供商和端点

| 提供商 | 端点 | 用例 |
| ----------------- | ----------------------------------------- | -------------- |
| `volcengine` | `ark.cn-beijing.volces.com/api/v3` | 通用模型 |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | 编码模型 |

两个提供商都使用单个 API 密钥配置。设置会自动注册两者。

## 可用模型

- **doubao-seed-1-8** — Doubao Seed 1.8（通用，默认）
- **doubao-seed-code-preview** — Doubao 编码模型
- **ark-code-latest** — 编码计划默认
- **Kimi K2.5** — 通过火山引擎的 Moonshot AI
- **GLM-4.7** — 通过火山引擎的 GLM
- **DeepSeek V3.2** — 通过火山引擎的 DeepSeek

大多数模型支持文本 + 图像输入。上下文窗口范围从 128K 到 256K tokens。

## 环境说明

如果 Gateway 作为守护进程运行（launchd/systemd），请确保 `VOLCANO_ENGINE_API_KEY` 对该进程可用（例如，在 `~/.openclaw/.env` 中或通过 `env.shellEnv`）。