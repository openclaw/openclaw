---
summary: "密钥管理：SecretRef 合约、运行时快照行为和安全单向清洗"
read_when:
  - 为提供者凭证和 `auth-profiles.json` 引用配置 SecretRefs
  - 在生产环境中安全地操作密钥重载、审计、配置和应用
  - 了解启动快速失败、非活跃表面过滤和最后已知良好行为
title: "密钥管理"
---

# 密钥管理

OpenClaw 支持增量式 SecretRefs，因此支持的凭证无需以明文形式存储在配置中。

明文仍然可以使用。SecretRefs 是按凭证可选加入的。

## 目标和运行时模型

密钥被解析到内存中的运行时快照中。

- 解析在激活时主动进行，而不是在请求路径上延迟进行。
- 当有效活动的 SecretRef 无法解析时，启动会快速失败。
- 重载使用原子交换：完全成功，或保留最后已知良好的快照。
- 运行时请求仅从活动的内存快照中读取。

这将密钥提供者故障排除在热门请求路径之外。

## 活动表面过滤

SecretRefs 仅在有效活动的表面上进行验证。

- 启用的表面：未解析的引用会阻止启动/重载。
- 非活跃表面：未解析的引用不会阻止启动/重载。
- 非活跃引用会发出带有代码 `SECRETS_REF_IGNORED_INACTIVE_SURFACE` 的非致命诊断信息。

非活跃表面的示例：

- 禁用的通道/账户条目。
- 没有启用账户继承的顶级通道凭证。
- 禁用的工具/功能表面。
- 未被 `tools.web.search.provider` 选择的 Web 搜索提供者特定密钥。
  在自动模式（未设置提供者）下，按优先级咨询密钥进行提供者自动检测，直到其中一个解析为止。
  选择后，非选中的提供者密钥在选中之前被视为非活跃。
- `gateway.remote.token` / `gateway.remote.password` SecretRefs 在以下情况之一为活动状态时是活动的（当 `gateway.remote.enabled` 不是 `false` 时）：
  - `gateway.mode=remote`
  - 配置了 `gateway.remote.url`
  - `gateway.tailscale.mode` 是 `serve` 或 `funnel`
    在没有这些远程表面的本地模式下：
  - 当没有配置 env/auth token 且 token 认证可以胜出时，`gateway.remote.token` 是活动的。
  - 当没有配置 env/auth password 且 password 认证可以胜出时，`gateway.remote.password` 是活动的。
- 当设置了 `OPENCLAW_GATEWAY_TOKEN`（或 `CLAWDBOT_GATEWAY_TOKEN`）时，`gateway.auth.token` SecretRef 在启动认证解析时是非活动的，因为 env token 输入在该运行时获胜。

## 网关认证表面诊断

当在 `gateway.auth.token`、`gateway.auth.password`、
`gateway.remote.token` 或 `gateway.remote.password` 上配置了 SecretRef 时，网关启动/重载会明确记录
表面状态：

- `active`：SecretRef 是有效认证表面的一部分，必须解析。
- `inactive`：SecretRef 在该运行时被忽略，因为另一个认证表面获胜，或
  因为远程认证被禁用/未激活。

这些条目使用 `SECRETS_GATEWAY_AUTH_SURFACE` 记录，包括活动表面策略使用的原因，因此您可以看到凭证为何被视为活动或非活动。

## 入门参考预检

当在交互模式下运行入门并选择 SecretRef 存储时，OpenClaw 在保存前运行预检验证：

- Env 引用：验证 env 变量名称，并确认在入门期间可见非空值。
- 提供者引用（`file` 或 `exec`）：验证提供者选择，解析 `id`，并检查解析值类型。
- 快速入门重用路径：当 `gateway.auth.token` 已经是 SecretRef 时，入站解析它后再进行探针/仪表板引导（对于 `env`、`file` 和 `exec` 引用），使用相同的快速失败门。

如果验证失败，入站显示错误并允许您重试。

## SecretRef 合约

在任何地方使用一种对象形状：

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }
```

验证：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须匹配 `^[A-Z][A-Z0-9_]{0,127}$`

### `source: "file"`

```json5
{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
```

验证：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须是绝对 JSON 指针（`/...`）
- RFC6901 转义分段：`~` => `~0`，`/` => `~1`

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

验证：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`

## 提供者配置

在 `secrets.providers` 下定义提供者：

```json5
{
  secrets: {
    providers: {
      default: { source: "env" },
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json", // 或 "singleValue"
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

### Env 提供者

- 可选的允许列表通过 `allowlist`。
- 缺失/空的 env 值会导致解析失败。

### File 提供者

- 从 `path` 读取本地文件。
- `mode: "json"` 期望 JSON 对象有效载荷，并将 `id` 解析为指针。
- `mode: "singleValue"` 期望引用 id `"value"` 并返回文件内容。
- 路径必须通过所有权/权限检查。
- Windows 失败关闭说明：如果无法对路径进行 ACL 验证，解析将失败。仅对于受信任的路径，在该提供者上设置 `allowInsecurePath: true` 以绕过路径安全检查。

### Exec 提供者

- 运行配置的可执行文件路径，无 shell。
- 默认情况下，`command` 必须指向一个常规文件（不是符号链接）。
- 设置 `allowSymlinkCommand: true` 以允许符号链接命令路径（例如 Homebrew shims）。OpenClaw 验证解析的目标路径。
- 将 `allowSymlinkCommand` 与 `trustedDirs` 配对用于包管理器路径（例如 `["/opt/homebrew"]`）。
- 支持超时、无输出超时、输出字节限制、env 允许列表和受信任目录。
- Windows 失败关闭说明：如果无法对命令路径进行 ACL 验证，解析将失败。仅对于受信任的路径，在该提供者上设置 `allowInsecurePath: true` 以绕过路径安全检查。

请求有效载荷（stdin）：

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

响应有效载荷（stdout）：

```jsonc
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "<openai-api-key>" } } // pragma: allowlist secret
```

可选的每 ID 错误：

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
        allowSymlinkCommand: true, // Homebrew 符号链接二进制文件所需
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
        allowSymlinkCommand: true, // Homebrew 符号链接二进制文件所需
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
        allowSymlinkCommand: true, // Homebrew 符号链接二进制文件所需
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

支持和不支持的规范凭证列在：

- [SecretRef 凭证表面](/reference/secretref-credential-surface)

运行时生成或轮换的凭证以及 OAuth 刷新材料被有意排除在只读 SecretRef 解析之外。

## 必需行为和优先级

- 没有引用的字段：保持不变。
- 有引用的字段：在激活期间的活动表面上是必需的。
- 如果同时存在明文和引用，引用在支持的优先级路径上优先。

警告和审计信号：

- `SECRETS_REF_OVERRIDES_PLAINTEXT`（运行时警告）
- `REF_SHADOWED`（审计发现，当 `auth-profiles.json` 凭证优先于 `openclaw.json` 引用时）

Google Chat 兼容行为：

- `serviceAccountRef` 优先于明文 `serviceAccount`。
- 当设置同级引用时，明文值被忽略。

## 激活触发器

密钥激活在以下情况下运行：

- 启动（预检加上最终激活）
- 配置重载热应用路径
- 配置重载重启检查路径
- 通过 `secrets.reload` 手动重载

激活合约：

- 成功时原子交换快照。
- 启动失败中止网关启动。
- 运行时重载失败保留最后已知良好的快照。

## 降级和恢复信号

当重载时激活在健康状态之后失败时，OpenClaw 进入降级密钥状态。

一次性系统事件和日志代码：

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

行为：

- 降级：运行时保留最后已知良好的快照。
- 恢复：在下一次成功激活后发出一次。
- 已经在降级状态时重复失败记录警告但不发送事件。
- 启动快速失败不会发出降级事件，因为运行时从未变为活动的。

## 命令路径解析

命令路径可以通过网关快照 RPC 选择加入支持的 SecretRef 解析。

有两种广泛的行为：

- 严格命令路径（例如 `openclaw memory` 远程内存路径和 `openclaw qr --remote`）从活动快照读取，并在必需的 SecretRef 不可用时快速失败。
- 只读命令路径（例如 `openclaw status`、`openclaw status --all`、`openclaw channels status`、`openclaw channels resolve` 和只读 doctor/config 修复流程）也优先使用活动快照，但在目标 SecretRef 在该命令路径中不可用时降级而不是中止。

只读行为：

- 当网关运行时，这些命令首先从活动快照读取。
- 如果网关解析不完整或网关不可用，它们会尝试针对特定命令表面进行本地回退。
- 如果目标 SecretRef 仍然不可用，命令继续进行降级的只读输出和明确诊断，例如"已配置但在该命令路径中不可用"。
- 这种降级行为仅限命令本地。它不会削弱运行时启动、重载或发送/认证路径。

其他说明：

- 后端密钥轮换后的快照刷新由 `openclaw secrets reload` 处理。
- 这些命令路径使用的网关 RPC 方法：`secrets.resolve`。

## 审计和配置工作流

默认操作员流程：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

### `secrets audit`

发现内容包括：

- 静态的明文值（`openclaw.json`、`auth-profiles.json`、`.env` 和生成的 `agents/*/agent/models.json`）
- 生成的 `models.json` 条目中的明文敏感提供者头部残留
- 未解析的引用
- 优先级遮蔽（`auth-profiles.json` 优先于 `openclaw.json` 引用）
- 遗留残留物（`auth.json`、OAuth 提醒）

头部残留说明：

- 敏感提供者头部检测基于名称启发式（常见 auth/credential 头部名称和片段，如 `authorization`、`x-api-key`、`token`、`secret`、`password` 和 `credential`）。

### `secrets configure`

交互式助手，可：

- 首先配置 `secrets.providers`（`env`/`file`/`exec`、添加/编辑/删除）
- 让您选择在 `openclaw.json` 以及 `auth-profiles.json` 中支持的携带密钥的字段，一个代理范围
- 可以在目标选择器中直接创建新的 `auth-profiles.json` 映射
- 捕获 SecretRef 详情（`source`、`provider`、`id`）
- 运行预检解析
- 可以立即应用

有用的模式：

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`
- `openclaw secrets configure --agent <id>`

`configure` 应用默认值：

- 从目标提供商的 `auth-profiles.json` 中清除匹配的静态凭证
- 从 `auth.json` 中清除遗留的静态 `api_key` 条目
- 从 `<config-dir>/.env` 中清除匹配的已知密钥行

### `secrets apply`

应用保存的计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
```

有关严格目标/路径合约详情和精确拒绝规则，请参阅：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

## 单向安全策略

OpenClaw 有意不写回滚备份，其中包含历史明文密钥值。

安全模型：

- 预检必须在写模式之前成功
- 运行时激活在提交之前被验证
- 应用使用原子文件替换更新文件，并在失败时尽力恢复

## 遗留认证兼容说明

对于静态凭证，运行时不再依赖明文遗留认证存储。

- 运行时凭证源是解析的内存快照。
- 遗留静态 `api_key` 条目在发现时被清除。
- OAuth 相关兼容行为保持分离。

## Web UI 说明

某些 SecretInput 联合在原始编辑器模式下比在表单模式下更容易配置。

## 相关文档

- CLI 命令：[secrets](/cli/secrets)
- 计划合约详情：[Secrets Apply Plan Contract](/gateway/secrets-plan-contract)
- 凭证表面：[SecretRef Credential Surface](/reference/secretref-credential-surface)
- 认证设置：[Authentication](/gateway/authentication)
- 安全态势：[Security](/gateway/security)
- 环境优先级：[Environment Variables](/help/environment)
