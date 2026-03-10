---
summary: "`openclaw secrets` CLI 参考（重载、审计、配置、应用）"
read_when:
  - 运行时重新解析密钥引用
  - 审计明文残留和未解析引用
  - 配置 SecretRefs 并应用单向清理变更
title: "secrets"
---

# `openclaw secrets`

使用 `openclaw secrets` 管理 SecretRefs 并保持活动运行时快照健康。

命令角色：

- `reload`: gateway RPC (`secrets.reload`) 重新解析引用并仅在完全成功时交换运行时快照（不写入配置）。
- `audit`: 对配置/认证存储和遗留残留进行只读扫描，检查明文、未解析引用和优先级漂移。
- `configure`: 提供商设置、目标映射和预检的交互式规划器（需要 TTY）。
- `apply`: 执行保存的计划（`--dry-run` 仅验证），然后清理目标明文残留。

推荐操作循环：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

CI/门禁的退出码说明：

- `audit --check` 发现问题时返回 `1`。
- 未解析引用返回 `2`。

相关文档：

- 密钥指南: [Secrets Management](/gateway/secrets)
- 凭证面: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- 安全指南: [Security](/gateway/security)

## 重载运行时快照

重新解析密钥引用并原子性交换运行时快照。

```bash
openclaw secrets reload
openclaw secrets reload --json
```

注意：

- 使用 gateway RPC 方法 `secrets.reload`。
- 如果解析失败，gateway 保留最后已知的良好快照并返回错误（无部分激活）。
- JSON 响应包含 `warningCount`。

## 审计

扫描 OpenClaw 状态以检测：

- 明文密钥存储
- 未解析引用
- 优先级漂移（`auth-profiles.json` 凭证覆盖 `openclaw.json` 引用）
- 遗留残留（旧版认证存储条目、OAuth 提醒）

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
```

退出行为：

- `--check` 发现问题时以非零退出。
- 未解析引用以更高优先级的非零码退出。

报告结构要点：

- `status`: `clean | findings | unresolved`
- `summary`: `plaintextCount`, `unresolvedRefCount`, `shadowedRefCount`, `legacyResidueCount`
- 发现码：
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## 配置（交互式助手）

交互式构建提供商和 SecretRef 变更，运行预检，并可选应用：

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

1. 首先设置提供商（`secrets.providers` 别名的 `add/edit/remove`）
2. 然后映射凭证（选择字段并分配 `{source, provider, id}` 引用）
3. 最后预检和可选应用

标志：

- `--providers-only`: 仅配置 `secrets.providers`，跳过凭证映射
- `--skip-provider-setup`: 跳过提供商设置，将凭证映射到现有提供商
- `--agent <id>`: 将 `auth-profiles.json` 目标发现和写入限定到一个代理存储

注意：

- 需要交互式 TTY。
- 不能同时使用 `--providers-only` 和 `--skip-provider-setup`。
- `configure` 目标是 `openclaw.json` 中的密钥承载字段以及选定代理作用域的 `auth-profiles.json`。
- `configure` 支持在选择器流程中直接创建新的 `auth-profiles.json` 映射。
- 规范支持面: [SecretRef Credential Surface](/reference/secretref-credential-surface)。
- 应用前执行预检解析。
- 生成的计划默认启用清理选项（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` 均启用）。
- 应用路径对已清理的明文值是单向的。
- 无 `--apply` 时，CLI 仍会在预检后提示 `Apply this plan now?`。
- 有 `--apply`（且无 `--yes`）时，CLI 会额外提示不可逆确认。

Exec 提供商安全注意：

- Homebrew 安装通常暴露 `/opt/homebrew/bin/*` 下的符号链接二进制文件。
- 仅在需要受信任的包管理器路径时设置 `allowSymlinkCommand: true`，并配合 `trustedDirs`（例如 `["/opt/homebrew"]`）。
- 在 Windows 上，如果提供商路径的 ACL 验证不可用，OpenClaw 会安全失败。仅对受信任路径设置 `allowInsecurePath: true` 以绕过路径安全检查。

## 应用保存的计划

应用或预检之前生成的计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

计划合约详情（允许的目标路径、验证规则和失败语义）：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

`apply` 可能更新的内容：

- `openclaw.json`（SecretRef 目标 + 提供商 upserts/deletes）
- `auth-profiles.json`（提供商目标清理）
- 遗留 `auth.json` 残留
- `~/.openclaw/.env` 已知密钥键（值已被迁移）

## 为什么没有回滚备份

`secrets apply` 故意不写入包含旧明文值的回滚备份。

安全性来自严格的预检 + 失败时的原子-ish 应用配合尽力而为的内存恢复。

## 示例

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如果 `audit --check` 仍报告明文发现，更新剩余报告的目标路径并重新运行审计。
