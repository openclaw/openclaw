---
summary: "`openclaw secrets` 的 CLI 参考（reload、audit、configure、apply）"
read_when:
  - 在运行时重新解析密钥引用
  - 审计明文残留和未解析的引用
  - 配置 SecretRef 并执行单向清理
title: "secrets"
---

# `openclaw secrets`

使用 `openclaw secrets` 将凭据从明文迁移到 SecretRef，并保持运行时密钥状态健康。

各子命令的角色：

- `reload`：网关 RPC（`secrets.reload`），重新解析引用并在完全成功时原子性地替换运行时快照（不写入配置文件）。
- `audit`：只读扫描配置、认证存储和遗留残留文件（`.env`、`auth.json`），检查明文、未解析引用和优先级偏移。
- `configure`：交互式规划器，用于配置供应商设置、目标映射和预检（需要 TTY）。
- `apply`：执行保存的迁移计划（`--dry-run` 仅做验证），然后清理已迁移的明文残留。

推荐的操作流程：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

CI/门控退出码说明：

- `audit --check` 在发现问题时返回 `1`，在引用未解析时返回 `2`。

相关文档：

- 密钥管理指南：[Secrets Management](/gateway/secrets)
- 安全指南：[Security](/gateway/security)

## 重载运行时快照

重新解析密钥引用并原子性地替换运行时快照。

```bash
openclaw secrets reload
openclaw secrets reload --json
```

说明：

- 使用网关 RPC 方法 `secrets.reload`。
- 如果解析失败，网关会保留上一次已知正常的快照并返回错误（不会部分激活）。
- JSON 响应包含 `warningCount`。

## 审计

扫描 OpenClaw 状态，检查：

- 明文密钥存储
- 未解析的引用
- 优先级偏移（`auth-profiles` 覆盖了配置中的引用）
- 遗留残留（`auth.json`、OAuth 相关说明）

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
```

退出行为：

- `--check` 在发现问题时以非零退出码退出。
- 未解析的引用会以更高优先级的非零退出码退出。

报告结构要点：

- `status`：`clean | findings | unresolved`
- `summary`：`plaintextCount`、`unresolvedRefCount`、`shadowedRefCount`、`legacyResidueCount`
- 发现代码：
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## Configure（交互式助手）

交互式构建供应商和 SecretRef 变更，运行预检，并可选择立即应用：

```bash
openclaw secrets configure
openclaw secrets configure --plan-out /tmp/openclaw-secrets-plan.json
openclaw secrets configure --apply --yes
openclaw secrets configure --providers-only
openclaw secrets configure --skip-provider-setup
openclaw secrets configure --json
```

流程：

- 首先配置供应商（为 `secrets.providers` 别名 `add/edit/remove`）。
- 然后映射凭据（选择字段并分配 `{source, provider, id}` 引用）。
- 最后预检和可选的应用。

参数：

- `--providers-only`：仅配置 `secrets.providers`，跳过凭据映射。
- `--skip-provider-setup`：跳过供应商配置，直接将凭据映射到已有供应商。

说明：

- 需要交互式 TTY。
- 不能同时使用 `--providers-only` 和 `--skip-provider-setup`。
- `configure` 作用于 `openclaw.json` 中包含密钥的字段。
- 请包含所有你打算迁移的密钥字段（例如 `models.providers.*.apiKey` 和 `skills.entries.*.apiKey`），这样审计才能达到干净状态。
- 应用前会执行预检解析。
- 生成的计划默认启用清理选项（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` 均启用）。
- Apply 路径对已迁移的明文值是单向的。
- 不使用 `--apply` 时，CLI 在预检后仍会提示 `Apply this plan now?`。
- 使用 `--apply`（且未使用 `--yes`）时，CLI 会额外提示不可逆迁移确认。

Exec 供应商安全说明：

- Homebrew 安装通常会在 `/opt/homebrew/bin/*` 下暴露符号链接的二进制文件。
- 仅在需要信任包管理器路径时设置 `allowSymlinkCommand: true`，并配合 `trustedDirs`（例如 `["/opt/homebrew"]`）使用。

## 应用保存的计划

应用或预检之前生成的迁移计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

计划合约详情（允许的目标路径、验证规则和失败语义）：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

`apply` 可能更新的内容：

- `openclaw.json`（SecretRef 目标 + 供应商的更新/删除）
- `auth-profiles.json`（供应商目标清理）
- 遗留的 `auth.json` 残留
- `~/.openclaw/.env` 中已迁移值对应的已知密钥

## 为什么没有回滚备份

`secrets apply` 故意不写入包含旧明文值的回滚备份。

安全性来自严格的预检 + 近原子性的应用，以及失败时的尽力内存恢复。

## 示例

```bash
# 先审计，再配置，最后确认干净：
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如果在部分迁移后 `audit --check` 仍然报告明文发现，请验证你是否也迁移了技能密钥（`skills.entries.*.apiKey`）以及其他报告的目标路径。
