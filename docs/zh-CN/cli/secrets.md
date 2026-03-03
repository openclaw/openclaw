---
summary: "`openclaw secrets` CLI 参考（重载、审计、配置、应用）"
read_when:
  - 运行时重新解析 SecretRef
  - 审计明文残留和未解析引用
  - 配置 SecretRef 并执行单向清理
title: "secrets"
---

# `openclaw secrets`

使用 `openclaw secrets` 管理 SecretRef，保持运行时快照健康。

命令角色：

- `reload`：Gateway RPC（`secrets.reload`），重新解析引用并在完全成功时原子交换运行时快照（不写入配置文件）。
- `audit`：只读扫描配置/认证存储中的明文、未解析引用和优先级偏移。
- `configure`：交互式规划器，用于 Provider 设置、目标映射和预检（需要 TTY）。
- `apply`：执行保存的计划（`--dry-run` 仅验证），然后清理目标明文残留。

推荐操作流程：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

CI/门控退出码说明：

- `audit --check` 有发现时返回 `1`。
- 未解析引用返回 `2`。

相关文档：

- 密钥管理指南：[Secrets Management](/gateway/secrets)
- 凭证范围：[SecretRef Credential Surface](/reference/secretref-credential-surface)
- 安全指南：[Security](/gateway/security)

## 重载运行时快照

重新解析 SecretRef 并原子交换运行时快照。

```bash
openclaw secrets reload
openclaw secrets reload --json
```

说明：

- 使用 Gateway RPC 方法 `secrets.reload`。
- 如果解析失败，Gateway 保留上一个正常快照并返回错误（不会部分激活）。
- JSON 响应包含 `warningCount`。

## 审计

扫描 OpenClaw 状态中的：

- 明文密钥存储
- 未解析引用
- 优先级偏移（`auth-profiles.json` 凭证覆盖 `openclaw.json` 引用）
- 旧版残留（旧版认证存储条目、OAuth 提醒）

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
```

退出行为：

- `--check` 有发现时以非零退出。
- 未解析引用以更高优先级非零码退出。

报告结构要点：

- `status`：`clean | findings | unresolved`
- `summary`：`plaintextCount`、`unresolvedRefCount`、`shadowedRefCount`、`legacyResidueCount`
- 发现代码：
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## 配置（交互式助手）

交互式构建 Provider 和 SecretRef 变更，运行预检，可选应用：

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

- 首先设置 Provider（对 `secrets.providers` 别名执行 `add/edit/remove`）。
- 其次映射凭证（选择字段并分配 `{source, provider, id}` 引用）。
- 最后预检和可选应用。

参数：

- `--providers-only`：仅配置 `secrets.providers`，跳过凭证映射。
- `--skip-provider-setup`：跳过 Provider 设置，将凭证映射到已有 Provider。
- `--agent <id>`：将 `auth-profiles.json` 目标发现和写入限定到单个 Agent 存储。

说明：

- 需要交互式 TTY。
- 不能同时使用 `--providers-only` 和 `--skip-provider-setup`。
- `configure` 针对 `openclaw.json` 中的密钥字段以及所选 Agent 范围内的 `auth-profiles.json`。
- 支持在选择器流程中直接创建新的 `auth-profiles.json` 映射。
- 规范支持范围：[SecretRef Credential Surface](/reference/secretref-credential-surface)。
- 应用前执行预检解析。
- 生成的计划默认启用清理选项（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` 均启用）。
- 应用路径对已清理的明文值是单向的。
- 不加 `--apply` 时，CLI 在预检后仍会提示 `Apply this plan now?`。
- 加 `--apply`（不加 `--yes`）时，CLI 会额外提示不可逆确认。

Exec Provider 安全说明：

- Homebrew 安装通常在 `/opt/homebrew/bin/*` 下暴露符号链接。
- 仅在需要可信包管理器路径时设置 `allowSymlinkCommand: true`，并配合 `trustedDirs`（例如 `["/opt/homebrew"]`）。
- 在 Windows 上，如果 ACL 验证对 Provider 路径不可用，OpenClaw 会安全失败。仅对可信路径设置 `allowInsecurePath: true` 以绕过路径安全检查。

## 应用保存的计划

应用或预检之前生成的计划：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

计划契约详情（允许的目标路径、验证规则和失败语义）：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

`apply` 可能更新的内容：

- `openclaw.json`（SecretRef 目标 + Provider 更新/删除）
- `auth-profiles.json`（Provider 目标清理）
- 旧版 `auth.json` 残留
- `~/.openclaw/.env` 中已迁移值的已知密钥

## 为什么没有回滚备份

`secrets apply` 故意不写入包含旧明文值的回滚备份。

安全性来自严格预检 + 原子式应用，失败时进行尽力内存恢复。

## 示例

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如果 `audit --check` 仍报告明文发现，更新报告中剩余的目标路径并重新运行审计。
