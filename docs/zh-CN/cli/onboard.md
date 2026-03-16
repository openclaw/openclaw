---
read_when:
  - 你想通过引导式设置来配置 Gateway 网关、工作区、身份验证、渠道和 Skills
summary: "`openclaw onboard` 的 CLI 参考（交互式设置向导）"
title: onboard
x-i18n:
  generated_at: "2026-03-16T06:21:32Z"
  model: gpt-5.4
  provider: openai
  source_hash: 04d7747342c582abcfcafff28847b4297f65ada665157d9cfbe3dbb258ee31d9
  source_path: cli/onboard.md
  workflow: 15
---

# `openclaw onboard`

交互式设置向导（本地或远程 Gateway 网关设置）。

## 相关指南

- CLI 新手引导中心：[设置向导（CLI）](/start/wizard)
- 新手引导概览：[新手引导概览](/start/onboarding-overview)
- CLI 新手引导参考：[CLI 设置参考](/start/wizard-cli-reference)
- CLI 自动化：[CLI 自动化](/start/wizard-cli-automation)
- macOS 新手引导：[新手引导（macOS 应用）](/start/onboarding)

## 示例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

对于明文私有网络 `ws://` 目标（仅限受信任网络），请在新手引导进程环境中设置
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

在非交互式模式下，`--custom-api-key` 是可选的。如果省略，新手引导会检查 `CUSTOM_API_KEY`。

非交互式 Ollama：

```bash
openclaw onboard --non-interactive \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b" \
  --accept-risk
```

`--custom-base-url` 默认为 `http://127.0.0.1:11434`。`--custom-model-id` 是可选的；如果省略，新手引导会使用 Ollama 建议的默认值。像 `kimi-k2.5:cloud` 这样的云端模型 ID 在这里也可用。

将提供商密钥存储为引用而不是明文：

```bash
openclaw onboard --non-interactive \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --accept-risk
```

使用 `--secret-input-mode ref` 时，新手引导会写入由环境变量支持的引用，而不是明文密钥值。
对于由 auth-profile 支持的提供商，这会写入 `keyRef` 条目；对于自定义提供商，这会将 `models.providers.<id>.apiKey` 写为环境变量引用（例如 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`）。

非交互式 `ref` 模式约定：

- 在新手引导进程环境中设置提供商环境变量（例如 `OPENAI_API_KEY`）。
- 不要传递内联密钥标志（例如 `--openai-api-key`），除非该环境变量也已设置。
- 如果传递了内联密钥标志但未设置所需环境变量，新手引导会快速失败并提供指引。

非交互式模式中的 Gateway 网关令牌选项：

- `--gateway-auth token --gateway-token <token>` 存储明文令牌。
- `--gateway-auth token --gateway-token-ref-env <name>` 将 `gateway.auth.token` 存储为环境变量 SecretRef。
- `--gateway-token` 和 `--gateway-token-ref-env` 互斥。
- `--gateway-token-ref-env` 要求在新手引导进程环境中存在一个非空环境变量。
- 使用 `--install-daemon` 时，当令牌身份验证需要令牌时，由 SecretRef 管理的 Gateway 网关令牌会被验证，但不会以已解析的明文形式持久化到 supervisor 服务环境元数据中。
- 使用 `--install-daemon` 时，如果令牌模式需要令牌，而配置的令牌 SecretRef 未解析，新手引导会以封闭失败方式终止，并提供修复指引。
- 使用 `--install-daemon` 时，如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password`，且 `gateway.auth.mode` 未设置，新手引导会阻止安装，直到显式设置 mode。

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

非交互式本地 Gateway 网关健康检查：

- 除非你传递 `--skip-health`，否则新手引导会等待本地 Gateway 网关可访问后才成功退出。
- `--install-daemon` 会先启动受管 Gateway 网关安装路径。不使用它时，你必须已经有一个正在运行的本地 Gateway 网关，例如 `openclaw gateway run`。
- 如果你只想在自动化中写入配置/工作区/bootstrap，请使用 `--skip-health`。
- 在原生 Windows 上，`--install-daemon` 会先尝试 Scheduled Tasks；如果任务创建被拒绝，则回退到每用户 Startup 文件夹登录项。

带引用模式的交互式新手引导行为：

- 出现提示时，选择**使用密钥引用**。
- 然后选择以下之一：
  - 环境变量
  - 已配置的密钥提供商（`file` 或 `exec`）
- 新手引导会在保存引用前执行快速预检验证。
  - 如果验证失败，新手引导会显示错误并让你重试。

非交互式 Z.AI 端点选择：

注意：`--auth-choice zai-api-key` 现在会为你的密钥自动检测最佳 Z.AI 端点（优先使用通用 API 搭配 `zai/glm-5`）。
如果你明确想使用 GLM Coding Plan 端点，请选择 `zai-coding-global` 或 `zai-coding-cn`。

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

- `quickstart`：最少提示，自动生成 Gateway 网关令牌。
- `manual`：提供端口/绑定/身份验证的完整提示（`advanced` 的别名）。
- 本地新手引导私信范围行为：[CLI 设置参考](/start/wizard-cli-reference#outputs-and-internals)。
- 最快开始第一次聊天：`openclaw dashboard`（控制 UI，无需设置渠道）。
- 自定义提供商：连接任何兼容 OpenAI 或 Anthropic 的端点，
  包括未列出的托管提供商。使用 Unknown 进行自动检测。

## 常见后续命令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 不代表非交互式模式。脚本请使用 `--non-interactive`。
</Note>
