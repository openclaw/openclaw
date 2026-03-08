---
summary: "密钥管理：SecretRef 契约、运行时快照行为和安全的单向清除"
read_when:
  - 为提供商凭证和 `auth-profiles.json` 引用配置 SecretRef
  - 在生产环境中操作密钥的重载、审计、配置和安全应用
  - 了解启动快速失败、非活动表面过滤和最后已知良好行为
title: "Secrets Management"
---

# 密钥管理

OpenClaw 支持增量式 SecretRef，使受支持的凭证无需以明文形式存储在配置中。

明文方式仍然可用。SecretRef 是按凭证选择性启用的。

## 目标和运行时模型

密钥在激活期间被解析为内存中的运行时快照。

- 解析在激活时是即时完成的，而非在请求路径上延迟执行。
- 当有效活跃的 SecretRef 无法解析时，启动会快速失败。
- 重载使用原子交换：完全成功，或保留最后已知良好的快照。
- 运行时请求仅从活跃的内存快照中读取。

这使得密钥提供商的中断不会影响热请求路径。

## 活跃表面过滤

SecretRef 仅在有效活跃的表面上进行验证。

- 已启用的表面：未解析的引用会阻止启动/重载。
- 非活跃表面：未解析的引用不会阻止启动/重载。
- 非活跃引用会发出非致命诊断信息，代码为 `SECRETS_REF_IGNORED_INACTIVE_SURFACE`。

非活跃表面的示例：

- 已禁用的渠道/账户条目。
- 没有已启用账户继承的顶级渠道凭证。
- 已禁用的工具/功能表面。
- 未被 `tools.web.search.provider` 选中的 Web 搜索提供商特定密钥。
  在 auto 模式下（未设置 provider），提供商特定密钥也会因提供商自动检测而处于活跃状态。
- `gateway.remote.token` / `gateway.remote.password` SecretRef 在 `gateway.remote.enabled` 不为 `false` 且满足以下条件之一时处于活跃状态：
  - `gateway.mode=remote`
  - 已配置 `gateway.remote.url`
  - `gateway.tailscale.mode` 为 `serve` 或 `funnel`
    在没有这些远程表面的本地模式下：
  - `gateway.remote.token` 在 token 认证可以胜出且未配置环境变量/auth token 时处于活跃状态。
  - `gateway.remote.password` 仅在密码认证可以胜出且未配置环境变量/auth 密码时处于活跃状态。

## Gateway 网关认证表面诊断

当在 `gateway.auth.password`、`gateway.remote.token` 或 `gateway.remote.password` 上配置了 SecretRef 时，Gateway 网关启动/重载会明确记录表面状态：

- `active`：该 SecretRef 是有效认证表面的一部分，必须解析。
- `inactive`：该 SecretRef 在此运行时中被忽略，因为另一个认证表面胜出，或者远程认证已禁用/未激活。

这些条目以 `SECRETS_GATEWAY_AUTH_SURFACE` 记录，并包含活跃表面策略使用的原因，以便你了解凭证被视为活跃或非活跃的原因。

## 新手引导引用预检

当新手引导以交互模式运行并选择 SecretRef 存储时，OpenClaw 会在保存前运行预检验证：

- Env 引用：验证环境变量名称并确认在新手引导期间可见非空值。
- 提供商引用（`file` 或 `exec`）：验证提供商选择，解析 `id`，并检查解析后的值类型。

如果验证失败，新手引导会显示错误并允许你重试。

## SecretRef 契约

在所有地方使用统一的对象格式：

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }
```

验证规则：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须匹配 `^[A-Z][A-Z0-9_]{0,127}$`

### `source: "file"`

```json5
{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
```

验证规则：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须是绝对 JSON 指针（`/...`）
- 段中的 RFC6901 转义：`~` => `~0`，`/` => `~1`

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

验证规则：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`

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
        mode: "json", // or "singleValue"
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        args: ["--profile", "prod"],
        passEnv: ["PATH", "VAULT_ADDR"],
        jsonOnly: true,
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
    resolution: {
      maxProviderConcurrency: 4,
      maxRefsPerProvider: 512,
      maxBatchBytes: 262144,
    },
  },
}
```

### Env 提供商

- 可通过 `allowlist` 配置可选的白名单。
- 缺失/空的环境变量值会导致解析失败。

### File 提供商

- 从 `path` 读取本地文件。
- `mode: "json"` 期望 JSON 对象负载，并将 `id` 作为指针解析。
- `mode: "singleValue"` 期望引用 id 为 `"value"` 并返回文件内容。
- 路径必须通过所有权/权限检查。
- Windows 安全关闭说明：如果某路径的 ACL 验证不可用，解析将失败。对于受信任的路径，可在该提供商上设置 `allowInsecurePath: true` 以绕过路径安全检查。

### Exec 提供商

- 运行配置的绝对二进制路径，不使用 shell。
- 默认情况下，`command` 必须指向常规文件（非符号链接）。
- 设置 `allowSymlinkCommand: true` 以允许符号链接命令路径（例如 Homebrew shim）。OpenClaw 会验证解析后的目标路径。
- 将 `allowSymlinkCommand` 与 `trustedDirs` 配合使用以支持包管理器路径（例如 `["/opt/homebrew"]`）。
- 支持超时、无输出超时、输出字节限制、环境变量白名单和受信任目录。
- Windows 安全关闭说明：如果命令路径的 ACL 验证不可用，解析将失败。对于受信任的路径，可在该提供商上设置 `allowInsecurePath: true` 以绕过路径安全检查。

请求负载（stdin）：

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

响应负载（stdout）：

```json
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "sk-..." } }
```

可选的按 id 错误：

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": { "providers/openai/apiKey": { "message": "not found" } }
}
```

## Exec 集成示例

### 1Password CLI

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["read", "op://Personal/OpenClaw QA API Key/password"],
        passEnv: ["HOME"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
      },
    },
  },
}
```

### HashiCorp Vault CLI

```json5
{
  secrets: {
    providers: {
      vault_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/vault",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["kv", "get", "-field=OPENAI_API_KEY", "secret/openclaw"],
        passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "vault_openai", id: "value" },
      },
    },
  },
}
```

### `sops`

```json5
{
  secrets: {
    providers: {
      sops_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/sops",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
        passEnv: ["SOPS_AGE_KEY_FILE"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "sops_openai", id: "value" },
      },
    },
  },
}
```

## 支持的凭证表面

规范的受支持和不受支持的凭证列在：

- [SecretRef 凭证表面](/reference/secretref-credential-surface)

运行时生成或轮换的凭证以及 OAuth 刷新材料被有意排除在只读 SecretRef 解析之外。

## 必要行为和优先级

- 没有引用的字段：保持不变。
- 有引用的字段：在激活期间对活跃表面是必需的。
- 如果同时存在明文和引用，引用在支持的优先级路径上优先。

警告和审计信号：

- `SECRETS_REF_OVERRIDES_PLAINTEXT`（运行时警告）
- `REF_SHADOWED`（当 `auth-profiles.json` 凭证优先于 `openclaw.json` 引用时的审计发现）

Google Chat 兼容性行为：

- `serviceAccountRef` 优先于明文 `serviceAccount`。
- 当设置了同级引用时，明文值被忽略。

## 激活触发器

密钥激活在以下情况运行：

- 启动（预检加最终激活）
- 配置重载热应用路径
- 配置重载重启检查路径
- 通过 `secrets.reload` 手动重载

激活契约：

- 成功时原子交换快照。
- 启动失败会中止 Gateway 网关启动。
- 运行时重载失败会保留最后已知良好的快照。

## 降级和恢复信号

当重载时激活在健康状态后失败时，OpenClaw 进入密钥降级状态。

一次性系统事件和日志代码：

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

行为：

- 降级：运行时保留最后已知良好的快照。
- 恢复：在下一次成功激活后发出一次。
- 在已降级状态下重复失败会记录警告，但不会重复发送事件。
- 启动快速失败不会发出降级事件，因为运行时从未变为活跃状态。

## 命令路径解析

选择性启用的凭证敏感命令路径（例如 `openclaw memory` 远程内存路径和 `openclaw qr --remote`）可以通过 Gateway 网关快照 RPC 解析受支持的 SecretRef。

- 当 Gateway 网关运行时，这些命令路径从活跃快照中读取。
- 如果需要已配置的 SecretRef 但 Gateway 网关不可用，命令解析会快速失败并提供可操作的诊断信息。
- 后端密钥轮换后的快照刷新由 `openclaw secrets reload` 处理。
- 这些命令路径使用的 Gateway 网关 RPC 方法：`secrets.resolve`。

## 审计和配置工作流

默认操作流程：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

### `secrets audit`

审计发现包括：

- 静态存储的明文值（`openclaw.json`、`auth-profiles.json`、`.env`）
- 未解析的引用
- 优先级遮蔽（`auth-profiles.json` 优先于 `openclaw.json` 引用）
- 遗留残留（`auth.json`、OAuth 提醒）

### `secrets configure`

交互式助手，功能包括：

- 首先配置 `secrets.providers`（`env`/`file`/`exec`，添加/编辑/删除）
- 允许你在 `openclaw.json` 和 `auth-profiles.json` 中为一个智能体范围选择受支持的密钥承载字段
- 可以在目标选择器中直接创建新的 `auth-profiles.json` 映射
- 捕获 SecretRef 详情（`source`、`provider`、`id`）
- 运行预检解析
- 可以立即应用

实用模式：

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`
- `openclaw secrets configure --agent <id>`

`configure` 应用默认行为：

- 从 `auth-profiles.json` 中清除目标提供商的匹配静态凭证
- 从 `auth.json` 中清除遗留的静态 `api_key` 条目
- 从 `<config-dir>/.env` 中清除匹配的已知密钥行

### `secrets apply`

应用已保存的计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
```

有关严格的目标/路径契约详情和精确的拒绝规则，请参阅：

- [Secrets Apply 计划契约](/gateway/secrets-plan-contract)

## 单向安全策略

OpenClaw 有意不写入包含历史明文密钥值的回滚备份。

安全模型：

- 预检必须在写入模式之前成功
- 运行时激活在提交之前经过验证
- apply 使用原子文件替换更新文件，并在失败时尽最大努力恢复

## 遗留认证兼容性说明

对于静态凭证，运行时不再依赖明文遗留认证存储。

- 运行时凭证来源是解析后的内存快照。
- 发现遗留的静态 `api_key` 条目时会被清除。
- OAuth 相关的兼容性行为保持独立。

## Web UI 说明

某些 SecretInput 联合类型在原始编辑器模式下比表单模式更容易配置。

## 相关文档

- CLI 命令：[secrets](/cli/secrets)
- 计划契约详情：[Secrets Apply 计划契约](/gateway/secrets-plan-contract)
- 凭证表面：[SecretRef 凭证表面](/reference/secretref-credential-surface)
- 认证设置：[认证](/gateway/authentication)
- 安全态势：[安全](/gateway/security)
- 环境变量优先级：[环境变量](/help/environment)
