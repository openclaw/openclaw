---
read_when:
  - 你想使用 GitHub Copilot 作为模型提供商
  - 你需要了解 `openclaw models auth login-github-copilot` 流程
summary: 使用设备流从 OpenClaw 登录 GitHub Copilot
title: GitHub Copilot
x-i18n:
  generated_at: "2026-02-01T21:34:57Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 503e0496d92c921e2f7111b1b4ba16374f5b781643bfbc6cb69cea97d9395c25
  source_path: providers/github-copilot.md
  workflow: 15
---

# GitHub Copilot

## 什么是 GitHub Copilot？

GitHub Copilot 是 GitHub 的 AI 编程助手。它为你的 GitHub 账户和订阅计划提供 Copilot 模型的访问权限。OpenClaw 可以通过两种不同的方式将 Copilot 用作模型提供商。

## 在 OpenClaw 中使用 Copilot 的两种方式

### 1）内置 GitHub Copilot 提供商（`github-copilot`）

使用原生设备登录流程获取 GitHub 令牌，然后在 OpenClaw 运行时将其兑换为 Copilot API 令牌。这是**默认**且最简单的方式，因为它不需要 VS Code。

### 2）Copilot Proxy 插件（`copilot-proxy`）

使用 **Copilot Proxy** VS Code 扩展作为本地桥接。OpenClaw 与代理的 `/v1` 端点通信，并使用你在其中配置的模型列表。当你已经在 VS Code 中运行 Copilot Proxy 或需要通过它进行路由时，选择此方式。你必须启用该插件并保持 VS Code 扩展运行。

使用 GitHub Copilot 作为模型提供商（`github-copilot`）。登录命令运行 GitHub 设备流程，保存认证配置文件，并更新你的配置以使用该配置文件。

## CLI 设置

```bash
openclaw models auth login-github-copilot
```

系统会提示你访问一个 URL 并输入一次性代码。请保持终端打开直到流程完成。

### 可选参数

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## 设置默认模型

```bash
openclaw models set github-copilot/gpt-4o
```

### 配置片段

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 注意事项

- 需要交互式 TTY；请直接在终端中运行。
- Copilot 模型的可用性取决于你的订阅计划；如果某个模型被拒绝，请尝试其他 ID（例如 `github-copilot/gpt-4.1`）。
- 登录会将 GitHub 令牌存储在认证配置文件中，并在 OpenClaw 运行时将其兑换为 Copilot API 令牌。
