---
summary: "OpenClaw onboarding CLI (`openclaw onboard`) — 交互式 Gateway、工作区和技能设置"
read_when:
  - 首次设置 OpenClaw
  - 重置配置并重新 onboarding
  - 配置远程 Gateway 连接
title: "onboard"
x-i18n:
  source_path: cli/onboard.md
  source_hash: da93ddf838dbd90cb1fd8d85a1050e053452ddd46ba2561fb4a309bb4f85c041
  generated_at: "2026-04-10T00:00:00Z"
  workflow: manual
---

# Onboard CLI

`openclaw onboard` 提供交互式 onboarding，用于设置 Gateway、工作区和技能。

## 运行 onboarding

```bash
openclaw onboard
```

### 选项

- `--workspace <dir>`：设置工作区目录。
- `--reset`：在 onboarding 之前重置配置 + 凭证 + 会话。
- `--reset-scope <config|config+creds+sessions|full>`：重置范围（默认 `config+creds+sessions`；使用 `full` 也会移除工作区）。
- `--non-interactive`：非交互式模式。
- `--mode <local|remote>`：onboarding 模式。
- `--flow <quickstart|advanced|manual>`：onboarding 流程（manual 是 advanced 的别名）。
- `--auth-choice <choice>`：认证提供者选择（见下文完整列表）。
- `--secret-input-mode <plaintext|ref>`：凭证存储模式（默认 `plaintext`；使用 `ref` 存储环境 SecretRef 而非明文密钥）。
- `--gateway-port <port>`：Gateway 端口。
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`：Gateway 绑定模式。
- `--gateway-auth <token|password>`：Gateway 认证模式。
- `--gateway-token <token>`：Gateway token。
- `--gateway-password <password>`：Gateway 密码。
- `--remote-url <url>`：远程 Gateway URL。
- `--remote-token <token>`：远程 Gateway token。
- `--tailscale <off|serve|funnel>`：Tailscale 暴露模式。
- `--install-daemon`：安装守护进程服务。
- `--skip-daemon`：跳过守护进程安装。
- `--skip-channels`：跳过渠道设置。
- `--skip-skills`：跳过技能安装。
- `--json`：JSON 输出。

## 支持的认证提供者

`--auth-choice` 支持以下值：

**主流提供者：**

- `chutes`、`deepseek-api-key`、`openai-codex`、`openai-api-key`
- `openrouter-api-key`、`kilocode-api-key`、`litellm-api-key`
- `ai-gateway-api-key`、`cloudflare-ai-gateway-api-key`

**中国提供者：**

- `moonshot-api-key`、`moonshot-api-key-cn`（月之暗面）
- `kimi-code-api-key`（Kimi）
- `zai-api-key`、`zai-coding-global`、`zai-coding-cn`（智谱 AI）
- `xiaomi-api-key`（小米）
- `minimax-global-oauth`、`minimax-global-api`、`minimax-cn-oauth`、`minimax-cn-api`（MiniMax）
- `qianfan-api-key`（百度千帆）
- `qwen-*` 系列（通义千问，见下方说明）

**其他提供者：**

- `synthetic-api-key`、`venice-api-key`、`together-api-key`
- `huggingface-api-key`、`gemini-api-key`、`google-gemini-cli`
- `opencode-zen`、`opencode-go`、`github-copilot`、`copilot-proxy`
- `xai-api-key`、`mistral-api-key`、`volcengine-api-key`、`byteplus-api-key`
- `custom-api-key`、`skip`

**Qwen 说明：** `qwen-*` 是规范的 auth-choice 系列。`modelstudio-*` ID 作为遗留兼容性别名仍然被接受。

## 自定义 API 密钥配置

使用 `--auth-choice custom-api-key` 时：

- `--custom-base-url <url>`：自定义 API 端点（必需）。
- `--custom-model-id <id>`：自定义模型 ID（必需）。
- `--custom-api-key <key>`：自定义 API 密钥（可选；省略时使用 `CUSTOM_API_KEY` 环境变量）。
- `--custom-provider-id <id>`：自定义提供者 ID（可选）。
- `--custom-compatibility <openai|anthropic>`：兼容性模式（默认 `openai`）。

## SecretRef 管理

使用 `--secret-input-mode ref` 时：

- 凭证存储为环境 SecretRef（如 `OPENAI_API_KEY`）而非明文。
- 更安全，适合生产环境。
- 需要预先设置相应的环境变量。

## 示例

```bash
# 交互式 onboarding
openclaw onboard

# 使用 OpenAI API 密钥
openclaw onboard --auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY

# 远程模式
openclaw onboard --mode remote --remote-url ws://example.com:18789 --remote-token $TOKEN

# 使用 Moonshot（月之暗面）
openclaw onboard --auth-choice moonshot-api-key --moonshot-api-key $MOONSHOT_API_KEY

# 使用智谱 AI
openclaw onboard --auth-choice zai-api-key --zai-api-key $ZAI_API_KEY

# 使用自定义 API
openclaw onboard --auth-choice custom-api-key --custom-base-url https://api.example.com --custom-model-id my-model

# 非交互式快速入门
openclaw onboard --non-interactive --flow quickstart --auth-choice openai-api-key
```

## Onboarding 流程

### Quickstart

- 自动选择最佳提供者
- 使用默认配置
- 最小化提示

### Advanced/Manual

- 完整的配置选项
- 详细的自定义设置
- 适合高级用户

## 输出

Onboarding 完成后：

- ✅ 创建 `~/.openclaw/openclaw.json` 配置文件
- ✅ 设置工作区目录
- ✅ 安装默认技能
- ✅ 配置认证凭证
- ✅ （可选）安装守护进程服务

使用 `--json` 获取机器可读的输出。
