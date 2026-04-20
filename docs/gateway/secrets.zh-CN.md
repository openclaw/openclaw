---
summary: "密钥管理：SecretRef 合约、运行时快照行为和安全的单向擦洗"
read_when:
  - 为提供商凭据和 `auth-profiles.json` 引用配置 SecretRefs
  - 在生产环境中安全地操作密钥重新加载、审计、配置和应用
  - 理解启动快速失败、非活动表面过滤和最后已知良好行为
title: "密钥管理"
---

# 密钥管理

OpenClaw 支持附加的 SecretRefs，因此支持的凭据不需要以明文形式存储在配置中。

明文仍然有效。SecretRefs 是每个凭据的可选选项。

## 目标和运行时模型

密钥被解析到内存中的运行时快照。

- 解析在激活期间是急切的，而不是在请求路径上懒惰的。
- 当有效激活的 SecretRef 无法解析时，启动会快速失败。
- 重新加载使用原子交换：完全成功，或保持最后已知良好的快照。
- SecretRef 策略违规（例如 OAuth 模式认证配置文件与 SecretRef 输入结合）在运行时交换之前激活失败。
- 运行时请求仅从活动的内存快照中读取。
- 在第一次成功的配置激活/加载后，运行时代码路径会一直读取该活动的内存快照，直到成功的重新加载交换它。
- 出站传递路径也从该活动快照中读取（例如 Discord 回复/线程传递和 Telegram 动作发送）；它们不会在每次发送时重新解析 SecretRefs。

这可以防止密钥提供商中断热请求路径。

## 活动表面过滤

SecretRefs 仅在有效活动的表面上进行验证。

- 启用的表面：未解析的引用会阻止启动/重新加载。
- 非活动的表面：未解析的引用不会阻止启动/重新加载。
- 非活动的引用会发出非致命诊断，代码为 `SECRETS_REF_IGNORED_INACTIVE_SURFACE`。

非活动表面的示例：

- 禁用的通道/账户条目。
- 没有启用的账户继承的顶级通道凭据。
- 禁用的工具/功能表面。
- 未被 `tools.web.search.provider` 选择的特定于 Web 搜索提供商的密钥。
  在自动模式（提供商未设置）下，密钥会按优先级咨询以进行提供商自动检测，直到一个解析。
  选择后，未选择的提供商密钥被视为非活动，直到被选择。
- 沙盒 SSH 认证材料（`agents.defaults.sandbox.ssh.identityData`、`certificateData`、`knownHostsData`，加上每个代理的覆盖）仅在默认代理或启用的代理的有效沙盒后端为 `ssh` 时才活动。
- `gateway.remote.token` / `gateway.remote.password` SecretRefs 在以下情况之一为活动：
  - `gateway.mode=remote`
  - `gateway.remote.url` 已配置
  - `gateway.tailscale.mode` 为 `serve` 或 `funnel`
  - 在没有这些远程表面的本地模式下：
    - 当令牌认证可以获胜且未配置环境/认证令牌时，`gateway.remote.token` 为活动。
    - 当密码认证可以获胜且未配置环境/认证密码时，`gateway.remote.password` 为活动。
- 当设置了 `OPENCLAW_GATEWAY_TOKEN` 时，`gateway.auth.token` SecretRef 在启动认证解析时为非活动，因为环境令牌输入在该运行时获胜。

## 网关认证表面诊断

当在 `gateway.auth.token`、`gateway.auth.password`、`gateway.remote.token` 或 `gateway.remote.password` 上配置 SecretRef 时，网关启动/重新加载会明确记录表面状态：

- `active`：SecretRef 是有效认证表面的一部分，必须解析。
- `inactive`：SecretRef 在此运行时被忽略，因为另一个认证表面获胜，或因为远程认证被禁用/不活动。

这些条目以 `SECRETS_GATEWAY_AUTH_SURFACE` 记录，并包括活动表面策略使用的原因，因此你可以看到为什么凭据被视为活动或非活动。

## 初始化参考预检

当初始化以交互模式运行且你选择 SecretRef 存储时，OpenClaw 在保存前运行预检验证：

- 环境引用：验证环境变量名称并确认设置期间可见非空值。
- 提供商引用（`file` 或 `exec`）：验证提供商选择，解析 `id`，并检查解析值类型。
- 快速启动重用路径：当 `gateway.auth.token` 已经是 SecretRef 时，初始化在探测/仪表板引导前解析它（对于 `env`、`file` 和 `exec` 引用），使用相同的快速失败门。

如果验证失败，初始化会显示错误并让你重试。

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
- `id` 必须是绝对 JSON 指针 (`/...`)
- 段中的 RFC6901 转义：`~` => `~0`，`/` => `~1`

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

验证：

- `provider` 必须匹配 `^[a-z][a-z0-9_-]{0,63}$`
- `id` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`
- `id` 不能包含 `.` 或 `..` 作为斜杠分隔的路径段（例如 `a/../b` 被拒绝）

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

### 环境提供商

- 通过 `allowlist` 可选的允许列表。
- 缺失/空环境值解析失败。

### 文件提供商

- 从 `path` 读取本地文件。
- `mode: "json"` 期望 JSON 对象有效负载并将 `id` 解析为指针。
- `mode: "singleValue"` 期望引用 id 为 `"value"` 并返回文件内容。
- 路径必须通过所有权/权限检查。
- Windows 关闭失败说明：如果路径的 ACL 验证不可用，解析失败。仅对于受信任的路径，在该提供商上设置 `allowInsecurePath: true` 以绕过路径安全检查。

### 执行提供商

- 运行配置的绝对二进制路径，无 shell。
- 默认情况下，`command` 必须指向常规文件（不是符号链接）。
- 设置 `allowSymlinkCommand: true` 以允许符号链接命令路径（例如 Homebrew shims）。OpenClaw 验证解析的目标路径。
- 将 `allowSymlinkCommand` 与 `trustedDirs` 配对用于包管理器路径（例如 `["/opt/homebrew"]`）。
- 支持超时、无输出超时、输出字节限制、环境允许列表和受信任目录。
- Windows 关闭失败说明：如果命令路径的 ACL 验证不可用，解析失败。仅对于受信任的路径，在该提供商上设置 `allowInsecurePath: true` 以绕过路径安全检查。

请求有效负载（stdin）：

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

响应有效负载（stdout）：

```jsonc
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "<openai-api-key>" } } // pragma: allowlist secret
```

可选的每个 id 错误：

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": { "providers/openai/apiKey": { "message": "not found" } }
}
```

## 执行集成示例

### 1Password CLI

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true, // 对于 Homebrew 符号链接二进制文件是必需的
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
        allowSymlinkCommand: true, // 对于 Homebrew 符号链接二进制文件是必需的
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
        allowSymlinkCommand: true, // 对于 Homebrew 符号链接二进制文件是必需的
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

## MCP 服务器环境变量

通过 `plugins.entries.acpx.config.mcpServers` 配置的 MCP 服务器环境变量支持 SecretInput。这可以防止 API 密钥和令牌出现在明文配置中：

```json5
{
  plugins: {
    entries: {
      acpx: {
        enabled: true,
        config: {
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: {
                GITHUB_PERSONAL_ACCESS_TOKEN: {
                  source: "env",
                  provider: "default",
                  id: "MCP_GITHUB_PAT",
                },
              },
            },
          },
        },
      },
    },
  },
}
```

明文字符串值仍然有效。环境模板引用（如 `${MCP_SERVER_API_KEY}`）和 SecretRef 对象在网关激活期间解析，然后再生成 MCP 服务器进程。与其他 SecretRef 表面一样，未解析的引用仅在 `acpx` 插件有效活动时阻止激活。

## 沙盒 SSH 认证材料

核心 `ssh` 沙盒后端也支持 SSH 认证材料的 SecretRefs：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "ssh",
        ssh: {
          target: "user@gateway-host:22",
          identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
      },
    },
  },
}
```

运行时行为：

- OpenClaw 在沙盒激活期间解析这些引用，而不是在每次 SSH 调用期间懒惰地解析。
- 解析的值被写入具有限制性权限的临时文件，并在生成的 SSH 配置中使用。
- 如果有效沙盒后端不是 `ssh`，这些引用保持非活动，不会阻止启动。

## 支持的凭据表面

规范的支持和不支持的凭据在以下位置列出：

- [SecretRef 凭据表面](/reference/secretref-credential-surface)

运行时生成或轮换的凭据和 OAuth 刷新材料被有意排除在只读 SecretRef 解析之外。

## 必需行为和优先级

- 没有引用的字段：保持不变。
- 有引用的字段：在激活期间在活动表面上是必需的。
- 如果同时存在明文和引用，引用在支持的优先级路径上优先。
- 编辑哨兵 `__OPENCLAW_REDACTED__` 保留用于内部配置编辑/恢复，被拒绝作为字面提交的配置数据。

警告和审计信号：

- `SECRETS_REF_OVERRIDES_PLAINTEXT`（运行时警告）
- `REF_SHADOWED`（当 `auth-profiles.json` 凭据优先于 `openclaw.json` 引用时的审计发现）

Google Chat 兼容性行为：

- `serviceAccountRef` 优先于明文 `serviceAccount`。
- 当设置了兄弟引用时，明文值被忽略。

## 激活触发

密钥激活在以下情况下运行：

- 启动（预检加上最终激活）
- 配置重新加载热应用路径
- 配置重新加载重启检查路径
- 通过 `secrets.reload` 手动重新加载
- 网关配置写入 RPC 预检（`config.set` / `config.apply` / `config.patch`），用于在持久化编辑之前提交的配置有效负载中的活动表面 SecretRef 可解析性

激活合约：

- 成功原子交换快照。
- 启动失败中止网关启动。
- 运行时重新加载失败保持最后已知良好的快照。
- 写入 RPC 预检失败拒绝提交的配置，并保持磁盘配置和活动运行时快照不变。
- 为出站助手/工具调用提供显式的每个调用通道令牌不会触发 SecretRef 激活；激活点仍然是启动、重新加载和显式的 `secrets.reload`。

## 降级和恢复信号

当在健康状态后重新加载时激活失败，OpenClaw 进入降级密钥状态。

一次性系统事件和日志代码：

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

行为：

- 降级：运行时保持最后已知良好的快照。
- 恢复：在下一次成功激活后发出一次。
- 在已经降级时重复失败会记录警告，但不会垃圾邮件事件。
- 启动快速失败不会发出降级事件，因为运行时从未变为活动。

## 命令路径解析

命令路径可以通过网关快照 RPC 选择支持的 SecretRef 解析。

有两种广泛的行为：

- 严格命令路径（例如 `openclaw memory` 远程内存路径和 `openclaw qr --remote` 当它需要远程共享秘密引用时）从活动快照读取，并在所需的 SecretRef 不可用时快速失败。
- 只读命令路径（例如 `openclaw status`、`openclaw status --all`、`openclaw channels status`、`openclaw channels resolve`、`openclaw security audit` 和只读 doctor/config 修复流程）也优先使用活动快照，但当目标 SecretRef 在该命令路径中不可用时会降级而不是中止。

只读行为：

- 当网关运行时，这些命令首先从活动快照读取。
- 如果网关解析不完整或网关不可用，它们会尝试针对特定命令表面的目标本地回退。
- 如果目标 SecretRef 仍然不可用，命令会继续使用降级的只读输出和显式诊断，例如“已配置但在此命令路径中不可用”。
- 这种降级行为仅在命令本地。它不会削弱运行时启动、重新加载或发送/认证路径。

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

发现包括：

- 静态明文值（`openclaw.json`、`auth-profiles.json`、`.env` 和生成的 `agents/*/agent/models.json`）
- 生成的 `models.json` 条目中的明文敏感提供商标头残留
- 未解析的引用
- 优先级阴影（`auth-profiles.json` 优先于 `openclaw.json` 引用）
- 遗留残留（`auth.json`、OAuth 提醒）

执行说明：

- 默认情况下，审计跳过执行 SecretRef 可解析性检查，以避免命令副作用。
- 使用 `openclaw secrets audit --allow-exec` 在审计期间执行执行提供商。

标头残留说明：

- 敏感提供商标头检测基于名称启发式（常见的认证/凭据标头名称和片段，如 `authorization`、`x-api-key`、`token`、`secret`、`password` 和 `credential`）。

### `secrets configure`

交互式助手：

- 首先配置 `secrets.providers`（`env`/`file`/`exec`，添加/编辑/删除）
- 让你在 `openclaw.json` 中选择支持的秘密承载字段，加上一个代理范围的 `auth-profiles.json`
- 可以在目标选择器中直接创建新的 `auth-profiles.json` 映射
- 捕获 SecretRef 详细信息（`source`、`provider`、`id`）
- 运行预检解析
- 可以立即应用

执行说明：

- 预检跳过执行 SecretRef 检查，除非设置了 `--allow-exec`。
- 如果你直接从 `configure --apply` 应用且计划包括执行引用/提供商，请为应用步骤也保持 `--allow-exec` 设置。

有用的模式：

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`
- `openclaw secrets configure --agent <id>`

`configure` 应用默认值：

- 从 `auth-profiles.json` 中擦洗目标提供商的匹配静态凭据
- 从 `auth.json` 中擦洗遗留静态 `api_key` 条目
- 从 `<config-dir>/.env` 中擦洗匹配的已知秘密行

### `secrets apply`

应用保存的计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
```

执行说明：

- 干运行跳过执行检查，除非设置了 `--allow-exec`。
- 写入模式拒绝包含执行 SecretRefs/提供商的计划，除非设置了 `--allow-exec`。

有关严格目标/路径合约详细信息和确切的拒绝规则，请参阅：

- [密钥应用计划合约](/gateway/secrets-plan-contract)

## 单向安全策略

OpenClaw 故意不写入包含历史明文秘密值的回滚备份。

安全模型：

- 写入模式前预检必须成功
- 运行时激活在提交前验证
- 应用使用原子文件替换更新文件，并在失败时尽力恢复

## 遗留认证兼容性说明

对于静态凭据，运行时不再依赖明文遗留认证存储。

- 运行时凭据源是解析的内存快照。
- 遗留静态 `api_key` 条目在发现时被擦洗。
- OAuth 相关的兼容性行为保持独立。

## Web UI 说明

一些 SecretInput 联合在原始编辑器模式中比在表单模式中更容易配置。

## 相关文档

- CLI 命令：[secrets](/cli/secrets)
- 计划合约详细信息：[密钥应用计划合约](/gateway/secrets-plan-contract)
- 凭据表面：[SecretRef 凭据表面](/reference/secretref-credential-surface)
- 认证设置：[认证](/gateway/authentication)
- 安全状态：[安全](/gateway/security)
- 环境优先级：[环境变量](/help/environment)
