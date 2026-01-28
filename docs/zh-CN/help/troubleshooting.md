---
read_when:
  - 你看到了错误并想找到修复路径
  - 安装程序显示"成功"但 CLI 无法工作
summary: 故障排除中心：症状 → 检查 → 修复
title: 故障排除
x-i18n:
  generated_at: "2026-02-01T20:40:26Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 00ba2a20732fa22ccf9bcba264ab06ea940e9d6e96b31290811ff21a670eaad2
  source_path: help/troubleshooting.md
  workflow: 14
---

# 故障排除

## 前 60 秒

按顺序运行以下命令：

```bash
openclaw status
openclaw status --all
openclaw gateway probe
openclaw logs --follow
openclaw doctor
```

如果 Gateway网关可达，进行深度探测：

```bash
openclaw status --deep
```

## 常见"出问题了"场景

### `openclaw: command not found`

几乎总是 Node/npm PATH 问题。从这里开始：

- [安装（Node/npm PATH 完整性检查）](/install#nodejs--npm-path-sanity)

### 安装程序失败（或你需要完整日志）

以详细模式重新运行安装程序，查看完整的跟踪信息和 npm 输出：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

对于 beta 安装：

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

你也可以设置 `OPENCLAW_VERBOSE=1` 来代替该标志。

### Gateway网关 "unauthorized"、无法连接或持续重连

- [Gateway网关故障排除](/gateway/troubleshooting)
- [Gateway网关认证](/gateway/authentication)

### 控制 UI 在 HTTP 上失败（需要设备身份）

- [Gateway网关故障排除](/gateway/troubleshooting)
- [控制 UI](/web/control-ui#insecure-http)

### `docs.openclaw.ai` 显示 SSL 错误（Comcast/Xfinity）

某些 Comcast/Xfinity 连接通过 Xfinity Advanced Security 屏蔽 `docs.openclaw.ai`。
禁用 Advanced Security 或将 `docs.openclaw.ai` 添加到允许列表，然后重试。

- Xfinity Advanced Security 帮助：https://www.xfinity.com/support/articles/using-xfinity-xfi-advanced-security
- 快速排查：尝试使用手机热点或 VPN 确认是否为 ISP 级别的过滤

### 服务显示运行中，但 RPC 探测失败

- [Gateway网关故障排除](/gateway/troubleshooting)
- [后台进程/服务](/gateway/background-process)

### 模型/认证失败（速率限制、计费、"所有模型均失败"）

- [模型](/cli/models)
- [OAuth / 认证概念](/concepts/oauth)

### `/model` 提示 `model not allowed`

这通常意味着 `agents.defaults.models` 被配置为允许列表。当其非空时，只有那些提供商/模型键可以被选择。

- 检查允许列表：`openclaw config get agents.defaults.models`
- 添加你需要的模型（或清空允许列表），然后重试 `/model`
- 使用 `/models` 浏览允许的提供商/模型

### 提交 issue 时

粘贴安全报告：

```bash
openclaw status --all
```

如果可以，请附上 `openclaw logs --follow` 中相关的日志尾部内容。
