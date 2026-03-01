---
summary: "Secrets 管理：SecretRef 合约、运行时快照行为和安全的单向清理"
read_when:
  - 为提供商、认证配置文件、技能或 Google Chat 配置 SecretRefs
  - 在生产环境中安全地操作 secrets 重新加载/审计/配置/应用
  - 理解快速失败和最后已知良好行为
title: "Secrets Management"
---

# Secrets 管理

OpenClaw 支持添加式 secret 引用，因此凭据无需以明文形式存储在配置文件中。

## 目标和运行时模型

Secrets 被解析到内存中的运行时快照。

- 解析在激活期间是积极的，不是在请求路径上惰性进行。
- 如果任何引用的凭据无法解析，启动会快速失败。
- 重新加载使用原子交换：完全成功或保持最后已知良好状态。

## SecretRef 合约

在任何地方使用一种对象格式：

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }
```

### `source: "file"`

```json5
{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
```

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

## 提供商配置

在 `secrets.providers` 下定义提供商：

```json5
{
  secrets: {
    providers: {
      default: { source: "env" },
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json",
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
      },
    },
  },
}
```

## CLI 命令

```bash
openclaw secrets audit      # 审计明文 secrets
openclaw secrets configure  # 交互式配置
openclaw secrets apply      # 应用计划
openclaw secrets reload     # 重新加载运行时快照
```
