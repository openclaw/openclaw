---
summary: "`openclaw onboard` 命令行参考（交互式入职）"
read_when:
  - 你需要网关、工作区、认证、频道和技能的引导设置
title: "onboard"
---

# `openclaw onboard`

本地或远程网关设置的交互式入职流程。

## 相关指南

- CLI 入职中心：[入职（CLI）](/start/wizard)
- 入职概述：[入职概述](/start/onboarding-overview)
- CLI 入职参考：[CLI 设置参考](/start/wizard-cli-reference)
- CLI 自动化：[CLI 自动化](/start/wizard-cli-automation)
- macOS 入职：[入职（macOS 应用）](/start/onboarding)

## 示例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

对于明文私有网络 `ws://` 目标（仅可信网络），在入职过程环境中设置
`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1`。

非交互式自定义提供商：

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --secret-input-mode plaintext \
  --custom-compatibility openai
```

在非交互式模式下，`--custom-api-key` 是可选的。如果省略，入职会检查 `CUSTOM_API_KEY`。

LM Studio 在非交互式模式下也支持提供商特定的密钥标志：

```bash
openclaw onboard --non-interactive \
  --auth-choice lmstudio \
  --custom-base-url "http://localhost:1234/v1" \
  --custom-model-id "qwen/qwen3.5-9b" \
  --lmstudio-api-key "$LM_API_TOKEN" \
  --accept-risk
```

非交互式 Ollama：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

`--custom-base-url` 默认值为 `http://127.0.0.1:11434`。`--custom-model-id` 是可选的；如果省略，入职会使用 Ollama 的建议默认值。云模型 ID 如 `kimi-k2.5:cloud` 也在这里工作。

将提供商密钥存储为引用而不是明文：

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

使用 `--secret-input-mode ref`，入职会写入基于环境的引用，而不是明文密钥值。
对于基于认证配置文件的提供商，这会写入 `keyRef` 条目；对于自定义提供商，这会将 `models.providers.<id>.apiKey` 写入为环境引用（例如 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`）。

非交互式 `ref` 模式约定：

- 在入职过程环境中设置提供商环境变量（例如 `OPENAI_API_KEY`）。
- 不要传递内联密钥标志（例如 `--openai-api-key`），除非该环境变量也已设置。
- 如果传递了内联密钥标志但没有设置所需的环境变量，入职会快速失败并提供指导。

非交互式模式下的网关令牌选项：

- `--gateway-auth token --gateway-token <token>` 存储明文令牌。
- `--gateway-auth token --gateway-token-ref-env <name>` 将 `gateway.auth.token` 存储为环境 SecretRef。
- `--gateway-token` 和 `--gateway-token-ref-env` 是互斥的。
- `--gateway-token-ref-env` 需要在入职过程环境中设置非空环境变量。
- 使用 `--install-daemon` 时，当令牌认证需要令牌时，SecretRef 管理的网关令牌会被验证，但不会作为解析的明文持久化到监督服务环境元数据中。
- 使用 `--install-daemon` 时，如果令牌模式需要令牌且配置的令牌 SecretRef 未解析，入职会失败并提供补救指导。
- 使用 `--install-daemon` 时，如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password` 且未设置 `gateway.auth.mode`，入职会阻止安装，直到明确设置模式。
- 本地入职会将 `gateway.mode="local"` 写入配置。如果后续配置文件缺少 `gateway.mode`，将其视为配置损坏或不完整的手动编辑，而不是有效的本地模式快捷方式。
- `--allow-unconfigured` 是一个单独的网关运行时逃生舱口。它并不意味着入职可以省略 `gateway.mode`。

示例：

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --accept-risk
```

非交互式本地网关健康：

- 除非你传递 `--skip-health`，否则入职会等待可访问的本地网关，然后才能成功退出。
- `--install-daemon` 首先启动托管网关安装路径。没有它，你必须已经运行了本地网关，例如 `openclaw gateway run`。
- 如果你只希望在自动化中进行配置/工作区/引导写入，请使用 `--skip-health`。
- 在原生 Windows 上，`--install-daemon` 首先尝试计划任务，如果任务创建被拒绝，则回退到每个用户的启动文件夹登录项。

参考模式下的交互式入职行为：

- 当提示时选择**使用密钥引用**。
- 然后选择：
  - 环境变量
  - 配置的密钥提供商（`file` 或 `exec`）
- 入职在保存引用之前执行快速预检验证。
  - 如果验证失败，入职会显示错误并让你重试。

非交互式 Z.AI 端点选择：

注意：`--auth-choice zai-api-key` 现在会自动检测你的密钥的最佳 Z.AI 端点（首选带有 `zai/glm-5.1` 的通用 API）。
如果你特别想要 GLM 编码计划端点，请选择 `zai-coding-global` 或 `zai-coding-cn`。

```bash
# 无提示端点选择
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# 其他 Z.AI 端点选择：
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

非交互式 Mistral 示例：

```bash
openclaw onboard --non-interactive \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

流程说明：

- `quickstart`：最小提示，自动生成网关令牌。
- `manual`：端口/绑定/认证的完整提示（`advanced` 的别名）。
- 当认证选择暗示首选提供商时，入职会将默认模型和允许列表选择器预过滤到该提供商。对于 Volcengine 和 BytePlus，这也匹配编码计划变体（`volcengine-plan/*`、`byteplus-plan/*`）。
- 如果首选提供商过滤器尚未产生任何加载的模型，入职会回退到未过滤的目录，而不是让选择器为空。
- 在网络搜索步骤中，一些提供商可以触发提供商特定的后续提示：
  - **Grok** 可以提供可选的 `x_search` 设置，使用相同的 `XAI_API_KEY` 和 `x_search` 模型选择。
  - **Kimi** 可以询问 Moonshot API 区域（`api.moonshot.ai` 与 `api.moonshot.cn`）和默认的 Kimi 网络搜索模型。
- 本地入职 DM 范围行为：[CLI 设置参考](/start/wizard-cli-reference#outputs-and-internals)。
- 最快的首次聊天：`openclaw dashboard`（控制 UI，无频道设置）。
- 自定义提供商：连接任何 OpenAI 或 Anthropic 兼容的端点，包括未列出的托管提供商。使用 Unknown 进行自动检测。

## 常见后续命令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 并不意味着非交互式模式。对于脚本，请使用 `--non-interactive`。
</Note>