---
summary: "CLI reference for `openclaw secrets` (reload, audit, configure, apply)"
read_when:
  - Re-resolving secret refs at runtime
  - Auditing plaintext residues and unresolved refs
  - Configuring SecretRefs and applying one-way scrub changes
title: secrets
---

# `openclaw secrets`

使用 `openclaw secrets` 來管理 SecretRefs 並保持活躍的執行時快照健康。

[[BLOCK_1]]  
指令角色：  
[[BLOCK_1]]

- `reload`: 網關 RPC (`secrets.reload`) 只在完全成功時重新解析引用並交換執行時快照（不進行設定寫入）。
- `audit`: 對設定/身份驗證/生成模型存儲和舊有殘留物的只讀掃描，以查找明文、未解析的引用和優先順序漂移。
- `configure`: 提供者設置、目標映射和預檢查的互動式規劃工具（需要 TTY）。
- `apply`: 執行已保存的計劃 (`--dry-run` 僅用於驗證)，然後清除目標明文殘留物。

[[BLOCK_N]]  
建議的運算子迴圈：  
[[BLOCK_N]]

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

[[BLOCK_1]]  
Exit code note for CI/gates:  
[[BLOCK_1]]

- `audit --check` 在發現時返回 `1`。
- 未解決的引用返回 `2`。

[[BLOCK_1]]

- 秘密管理指南: [Secrets Management](/gateway/secrets)
- 憑證介面: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- 安全指南: [Security](/gateway/security)

## 重新載入執行時快照

重新解析秘密引用並原子性地交換執行時快照。

```bash
openclaw secrets reload
openclaw secrets reload --json
```

[[BLOCK_1]]

- 使用閘道 RPC 方法 `secrets.reload`。
- 如果解析失敗，閘道會保留最後已知的良好快照並返回錯誤（不進行部分啟用）。
- JSON 回應包含 `warningCount`。

## Audit

掃描 OpenClaw 狀態以獲取：

- 明文秘密儲存
- 未解決的引用
- 優先權漂移 (`auth-profiles.json` 憑證遮蔽 `openclaw.json` 引用)
- 生成的 `agents/*/agent/models.json` 殘留物（提供者 `apiKey` 值和敏感提供者標頭）
- 遺留殘留物（遺留身份驗證儲存條目、OAuth 提醒）

Header residue note:

- 敏感提供者標頭檢測是基於名稱的啟發式方法（常見的身份驗證/憑證標頭名稱和片段，例如 `authorization`、`x-api-key`、`token`、`secret`、`password` 和 `credential`）。

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
```

[[BLOCK_1]]  
Exit behavior:  
[[INLINE_1]]

- `--check` 在發現時會以非零值退出。
- 未解決的引用會以更高優先級的非零程式碼退出。

報告形狀重點：

- `status`: `clean | findings | unresolved`
- `summary`: `plaintextCount`, `unresolvedRefCount`, `shadowedRefCount`, `legacyResidueCount`
- 尋找程式碼:
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## Configure (互動式助手)

建立提供者和 SecretRef 變更互動式執行，執行預檢，並可選擇應用：

```bash
openclaw secrets configure
openclaw secrets configure --plan-out /tmp/openclaw-secrets-plan.json
openclaw secrets configure --apply --yes
openclaw secrets configure --providers-only
openclaw secrets configure --skip-provider-setup
openclaw secrets configure --agent ops
openclaw secrets configure --json
```

[[BLOCK_1]]

- 首先設置提供者 (`add/edit/remove` 用於 `secrets.providers` 別名)。
- 其次進行憑證映射（選擇欄位並分配 `{source, provider, id}` 參考）。
- 最後進行預檢和可選的應用。

Flags:

- `--providers-only`: 僅設定 `secrets.providers`，跳過憑證映射。
- `--skip-provider-setup`: 跳過提供者設置，並將憑證映射到現有提供者。
- `--agent <id>`: 將 `auth-profiles.json` 的範圍目標發現和寫入限制在一個代理儲存。

[[BLOCK_1]]

- 需要互動式 TTY。
- 你不能將 `--providers-only` 與 `--skip-provider-setup` 結合使用。
- `configure` 針對 `openclaw.json` 中的秘密承載欄位以及 `auth-profiles.json` 針對所選代理範圍。
- `configure` 支援在選擇器流程中直接創建新的 `auth-profiles.json` 對應。
- 標準支援的介面：[SecretRef Credential Surface](/reference/secretref-credential-surface)。
- 在應用之前會執行預檢解析。
- 生成的計劃預設為清除選項（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` 全部啟用）。
- 應用路徑對於已清除的明文值是單向的。
- 在沒有 `--apply` 的情況下，CLI 在預檢後仍會提示 `Apply this plan now?`。
- 在有 `--apply`（且沒有 `--yes`）的情況下，CLI 會提示額外的不可逆確認。

[[BLOCK_1]]  
執行提供者安全注意事項：  
[[BLOCK_1]]

- Homebrew 安裝通常會在 `/opt/homebrew/bin/*` 下暴露符號連結的二進位檔。
- 只有在需要時，才為受信任的套件管理器路徑設置 `allowSymlinkCommand: true`，並與 `trustedDirs` 配對（例如 `["/opt/homebrew"]`）。
- 在 Windows 上，如果提供者路徑無法進行 ACL 驗證，OpenClaw 將會安全失敗。僅對受信任的路徑，將 `allowInsecurePath: true` 設置在該提供者上以繞過路徑安全檢查。

## 應用已儲存的計畫

應用或預檢先前生成的計畫：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

計畫合約細節（允許的目標路徑、驗證規則和失敗語義）：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

`apply` 可能會更新：

- `openclaw.json` (SecretRef 目標 + 提供者的更新/刪除)
- `auth-profiles.json` (提供者目標的清理)
- legacy `auth.json` 殘留物
- `~/.openclaw/.env` 已知的秘密金鑰，其值已被遷移

## 為什麼沒有回滾備份

`secrets apply` 故意不寫入包含舊明文值的回滾備份。

安全性來自於嚴格的預檢和類原子應用，並在失敗時進行最佳努力的記憶體恢復。

## Example

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如果 `audit --check` 仍然報告純文字發現，請更新其餘報告的目標路徑並重新執行審核。
