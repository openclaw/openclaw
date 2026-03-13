---
summary: "CLI reference for `openclaw secrets` (reload, audit, configure, apply)"
read_when:
  - Re-resolving secret refs at runtime
  - Auditing plaintext residues and unresolved refs
  - Configuring SecretRefs and applying one-way scrub changes
title: secrets
---

# `openclaw secrets`

使用 `openclaw secrets` 來管理 SecretRefs 並維持執行時快照的健康狀態。

指令角色：

- `reload`：gateway RPC（`secrets.reload`），在完全成功時重新解析 refs 並交換執行時快照（不進行設定寫入）。
- `audit`：只讀掃描設定／認證／生成模型存儲與舊有殘留，檢查明文、未解析的 refs 及優先權漂移。
- `configure`：互動式規劃器，用於提供者設定、目標映射及預檢（需 TTY）。
- `apply`：執行已儲存的計劃（`--dry-run` 僅供驗證），然後清理指定的明文殘留。

建議的操作循環：

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

CI／門檻的退出碼說明：

- `audit --check` 在有發現時回傳 `1`。
- 未解析的 refs 回傳 `2`。

相關資源：

- Secrets 指南：[Secrets Management](/gateway/secrets)
- 憑證介面：[SecretRef Credential Surface](/reference/secretref-credential-surface)
- 安全指南：[Security](/gateway/security)

## 重新載入執行時快照

重新解析 secret refs 並原子性交換執行時快照。

```bash
openclaw secrets reload
openclaw secrets reload --json
```

注意事項：

- 使用 gateway RPC 方法 `secrets.reload`。
- 若解析失敗，gateway 保持最後已知良好快照並回傳錯誤（不進行部分啟用）。
- JSON 回應包含 `warningCount`。

## 稽核

掃描 OpenClaw 狀態以檢查：

- 明文秘密存放
- 未解析的參考
- 優先權漂移 (`auth-profiles.json` 憑證覆蓋 `openclaw.json` 參考)
- 產生的 `agents/*/agent/models.json` 殘留物（提供者 `apiKey` 值與敏感提供者標頭）
- 舊版殘留物（舊版認證存放條目、OAuth 提醒）

標頭殘留物說明：

- 敏感提供者標頭偵測是基於名稱啟發式（常見的認證/憑證標頭名稱與片段，如 `authorization`、`x-api-key`、`token`、`secret`、`password` 及 `credential`）。

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
```

結束行為：

- `--check` 在發現問題時以非零狀態碼結束。
- 未解析的參考以優先權較高的非零狀態碼結束。

報告格式重點：

- `status`：`clean | findings | unresolved`
- `summary`：`plaintextCount`、`unresolvedRefCount`、`shadowedRefCount`、`legacyResidueCount`
- 發現程式碼：
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## 設定（互動式輔助）

互動式建立提供者與 SecretRef 變更，執行預檢，並可選擇套用：

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

- 先設定提供者（`add/edit/remove` 用於 `secrets.providers` 別名）。
- 再進行憑證對應（選擇欄位並指派 `{source, provider, id}` 參考）。
- 最後執行預檢並可選擇套用。

Flags:

- `--providers-only`：僅設定 `secrets.providers`，跳過憑證映射。
- `--skip-provider-setup`：跳過提供者設定，並將憑證映射到現有提供者。
- `--agent <id>`：限定 `auth-profiles.json` 目標發現範圍，並寫入單一代理儲存。

Notes:

- 需要互動式 TTY。
- 不能同時使用 `--providers-only` 與 `--skip-provider-setup`。
- `configure` 針對 `openclaw.json` 中帶有秘密的欄位，以及所選代理範圍的 `auth-profiles.json`。
- `configure` 支援在選擇流程中直接建立新的 `auth-profiles.json` 映射。
- 正式支援的介面為：[SecretRef Credential Surface](/reference/secretref-credential-surface)。
- 執行前會先進行預檢解析。
- 產生的計畫預設啟用清理選項（`scrubEnv`、`scrubAuthProfilesForProviderTargets`、`scrubLegacyAuthJson` 全部啟用）。
- 套用路徑對於已清理的純文字值是單向的。
- 未使用 `--apply` 時，CLI 在預檢後仍會提示 `Apply this plan now?`。
- 使用 `--apply`（且未使用 `--yes`）時，CLI 會額外提示不可逆的確認。

Exec provider safety note:

- Homebrew 安裝通常會在 `/opt/homebrew/bin/*` 下暴露符號連結的二進位檔。
- 僅在需要信任的套件管理器路徑時設定 `allowSymlinkCommand: true`，並搭配 `trustedDirs`（例如 `["/opt/homebrew"]`）。
- 在 Windows 上，如果無法對提供者路徑進行 ACL 驗證，OpenClaw 將會封鎖執行。僅對信任路徑，於該提供者設定 `allowInsecurePath: true` 以繞過路徑安全檢查。

## 套用已儲存的計畫

套用或預檢先前產生的計畫：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

計畫合約細節（允許的目標路徑、驗證規則與失敗語意）：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

`apply` 可能更新的專案：

- `openclaw.json`（SecretRef 目標 + 提供者新增/刪除）
- `auth-profiles.json`（提供者目標清理）
- 傳統 `auth.json` 殘留
- `~/.openclaw/.env` 已知秘密金鑰，其值已遷移

## 為何沒有回滾備份

`secrets apply` 故意不寫入包含舊純文字值的回滾備份。

安全性來自嚴格的預檢程序 + 近乎原子性的套用，並在失敗時盡力進行記憶體內還原。

## 範例

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如果 `audit --check` 仍然報告明文發現，請更新剩餘報告的目標路徑並重新執行稽核。
