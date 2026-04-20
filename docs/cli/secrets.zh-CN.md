---
summary: "`openclaw secrets` 命令行参考（重新加载、审计、配置、应用）"
read_when:
  - 在运行时重新解析密钥引用
  - 审计明文残留和未解析的引用
  - 配置 SecretRef 并应用单向清理更改
title: "secrets"
---

# `openclaw secrets`

使用 `openclaw secrets` 管理 SecretRef 并保持活动运行时快照健康。

命令角色：

- `reload`：网关 RPC（`secrets.reload`），仅在完全成功时重新解析引用并交换运行时快照（无配置写入）。
- `audit`：对配置/认证/生成的模型存储和遗留残留进行只读扫描，查找明文、未解析的引用和优先级漂移（除非设置了 `--allow-exec`，否则跳过 exec 引用）。
- `configure`：提供商设置、目标映射和预检的交互式规划器（需要 TTY）。
- `apply`：执行保存的计划（`--dry-run` 仅用于验证；干运行默认跳过 exec 检查，写入模式拒绝包含 exec 的计划，除非设置了 `--allow-exec`），然后清理目标明文残留。

推荐的操作员循环：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

如果你的计划包含 `exec` SecretRef/提供商，请在干运行和写入应用命令上传递 `--allow-exec`。

CI/门控的退出代码注意：

- `audit --check` 在发现时返回 `1`。
- 未解析的引用返回 `2`。

相关：

- 密钥指南：[密钥管理](/gateway/secrets)
- 凭证表面：[SecretRef 凭证表面](/reference/secretref-credential-surface)
- 安全指南：[安全](/gateway/security)

## 重新加载运行时快照

重新解析密钥引用并原子性地交换运行时快照。

```bash
openclaw secrets reload
openclaw secrets reload --json
openclaw secrets reload --url ws://127.0.0.1:18789 --token <token>
```

注意：

- 使用网关 RPC 方法 `secrets.reload`。
- 如果解析失败，网关会保留最后已知的良好快照并返回错误（无部分激活）。
- JSON 响应包含 `warningCount`。

选项：

- `--url <url>`
- `--token <token>`
- `--timeout <ms>`
- `--json`

## 审计

扫描 OpenClaw 状态以查找：

- 明文密钥存储
- 未解析的引用
- 优先级漂移（`auth-profiles.json` 凭证遮蔽 `openclaw.json` 引用）
- 生成的 `agents/*/agent/models.json` 残留（提供商 `apiKey` 值和敏感提供商标头）
- 遗留残留（遗留认证存储条目、OAuth 提醒）

标头残留注意：

- 敏感提供商标头检测基于名称启发式（常见的认证/凭证标头名称和片段，如 `authorization`、`x-api-key`、`token`、`secret`、`password` 和 `credential`）。

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
openclaw secrets audit --allow-exec
```

退出行为：

- `--check` 在发现时以非零状态退出。
- 未解析的引用以更高优先级的非零代码退出。

报告形状亮点：

- `status`：`clean | findings | unresolved`
- `resolution`：`refsChecked`、`skippedExecRefs`、`resolvabilityComplete`
- `summary`：`plaintextCount`、`unresolvedRefCount`、`shadowedRefCount`、`legacyResidueCount`
- 发现代码：
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## 配置（交互式助手）

交互式构建提供商和 SecretRef 更改，运行预检，并可选地应用：

```bash
openclaw secrets configure
openclaw secrets configure --plan-out /tmp/openclaw-secrets-plan.json
openclaw secrets configure --apply --yes
openclaw secrets configure --providers-only
openclaw secrets configure --skip-provider-setup
openclaw secrets configure --agent ops
openclaw secrets configure --json
```

流程：

- 首先设置提供商（`secrets.providers` 别名的 `add/edit/remove`）。
- 其次进行凭证映射（选择字段并分配 `{source, provider, id}` 引用）。
- 最后进行预检和可选的应用。

标志：

- `--providers-only`：仅配置 `secrets.providers`，跳过凭证映射。
- `--skip-provider-setup`：跳过提供商设置，将凭证映射到现有提供商。
- `--agent <id>`：将 `auth-profiles.json` 目标发现和写入范围限定到一个代理存储。
- `--allow-exec`：允许在预检/应用期间进行 exec SecretRef 检查（可能执行提供商命令）。

注意：

- 需要交互式 TTY。
- 不能将 `--providers-only` 与 `--skip-provider-setup` 组合使用。
- `configure` 目标 `openclaw.json` 中的密钥字段以及选定代理范围的 `auth-profiles.json`。
- `configure` 支持在选择器流程中直接创建新的 `auth-profiles.json` 映射。
- 规范支持的表面：[SecretRef 凭证表面](/reference/secretref-credential-surface)。
- 它在应用前执行预检解析。
- 如果预检/应用包含 exec 引用，请在两个步骤中都保持 `--allow-exec` 设置。
- 生成的计划默认为清理选项（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` 均已启用）。
- 应用路径对于清理的明文值是单向的。
- 没有 `--apply`，CLI 仍会在预检后提示 `Apply this plan now?`。
- 使用 `--apply`（且没有 `--yes`），CLI 会提示额外的不可逆转确认。
- `--json` 打印计划 + 预检报告，但该命令仍然需要交互式 TTY。

Exec 提供商安全注意：

- Homebrew 安装通常在 `/opt/homebrew/bin/*` 下公开符号链接的二进制文件。
- 仅在需要可信包管理器路径时设置 `allowSymlinkCommand: true`，并将其与 `trustedDirs` 配对（例如 `["/opt/homebrew"]`）。
- 在 Windows 上，如果提供商路径的 ACL 验证不可用，OpenClaw 会失败关闭。仅对于可信路径，在该提供商上设置 `allowInsecurePath: true` 以绕过路径安全检查。

## 应用保存的计划

应用或预检先前生成的计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

Exec 行为：

- `--dry-run` 验证预检而不写入文件。
- 干运行中默认跳过 exec SecretRef 检查。
- 写入模式拒绝包含 exec SecretRef/提供商的计划，除非设置了 `--allow-exec`。
- 使用 `--allow-exec` 选择在任一模式下进行 exec 提供商检查/执行。

计划契约详细信息（允许的目标路径、验证规则和失败语义）：

- [密钥应用计划契约](/gateway/secrets-plan-contract)

`apply` 可能更新的内容：

- `openclaw.json`（SecretRef 目标 + 提供商 upserts/deletes）
- `auth-profiles.json`（提供商目标清理）
- 遗留 `auth.json` 残留
- `~/.openclaw/.env` 已知密钥，其值已迁移

## 为什么没有回滚备份

`secrets apply` 有意不写入包含旧明文值的回滚备份。

安全性来自严格的预检 + 原子性应用，在失败时进行最佳努力的内存恢复。

## 示例

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如果 `audit --check` 仍报告明文发现，请更新剩余报告的目标路径并重新运行审计。