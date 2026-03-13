---
summary: "Exec tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the exec tool
  - Debugging stdin or TTY behavior
title: Exec Tool
---

# Exec 工具

在工作區中執行 shell 指令。支援透過 `process` 進行前景與背景執行。  
如果不允許 `process`，`exec` 將同步執行，並忽略 `yieldMs`/`background`。  
背景工作階段以代理為範圍；`process` 僅能看到同一代理的工作階段。

## 參數

- `command`（必填）
- `workdir`（預設為目前工作目錄）
- `env`（鍵/值覆寫）
- `yieldMs`（預設 10000）：延遲後自動背景執行
- `background`（布林值）：立即背景執行
- `timeout`（秒，預設 1800）：到期時終止
- `pty`（布林值）：在可用時於偽終端機執行（僅限 TTY CLI、程式代理、終端機 UI）
- `host`（`sandbox | gateway | node`）：執行位置
- `security`（`deny | allowlist | full`）：`gateway`/`node` 的強制模式
- `ask`（`off | on-miss | always`）：`gateway`/`node` 的批准提示
- `node`（字串）：`host=node` 的節點 ID/名稱
- `elevated`（布林值）：請求提升模式（閘道主機）；僅當提升解析為 `full` 時，`security=full` 才會被強制

備註：

- `host` 預設為 `sandbox`。
- 當 sandboxing 關閉時，`elevated` 會被忽略（exec 已經在主機上執行）。
- `gateway`/`node` 的核准由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要配對節點（伴侶應用程式或無頭節點主機）。
- 如果有多個節點可用，請設定 `exec.node` 或 `tools.exec.node` 來選擇其中一個。
- 在非 Windows 主機上，exec 在設定 `SHELL` 時會使用它；如果 `SHELL` 是 `fish`，則優先使用來自 `PATH` 的 `bash`（或 `sh`），以避免不相容 fish 的腳本，若兩者皆不存在則退回使用 `SHELL`。
- 在 Windows 主機上，exec 優先尋找 PowerShell 7 (`pwsh`)（依序從 Program Files、ProgramW6432，再到 PATH），若找不到則退回使用 Windows PowerShell 5.1。
- 主機執行 (`gateway`/`node`) 拒絕 `env.PATH` 及 loader 覆寫 (`LD_*`/`DYLD_*`)，以防止二進位劫持或注入程式碼。
- OpenClaw 在產生的命令環境（包含 PTY 及 sandbox 執行）中設定 `OPENCLAW_SHELL=exec`，讓 shell/profile 規則能偵測 exec-tool 的執行上下文。
- 重要：sandboxing **預設為關閉**。若 sandboxing 關閉且明確設定/要求 `host=sandbox`，exec 現在會封閉失敗，而非靜默在 gateway 主機上執行。請啟用 sandboxing 或搭配核准使用 `host=gateway`。
- 腳本預檢查（針對常見的 Python/Node shell 語法錯誤）僅會檢查有效 `workdir` 範圍內的檔案。若腳本路徑解析後位於 `workdir` 之外，該檔案的預檢查將被跳過。

## 設定

- `tools.exec.notifyOnExit`（預設值：true）：當設為 true 時，背景執行的 exec 會在結束時排入系統事件並請求心跳。
- `tools.exec.approvalRunningNoticeMs`（預設值：10000）：當有審核門控的 exec 執行時間超過此值時，發出一次「執行中」通知（設為 0 則停用）。
- `tools.exec.host`（預設值：`sandbox`）
- `tools.exec.security`（預設值：未設定時，sandbox 為 `deny`，gateway 與 node 為 `allowlist`）
- `tools.exec.ask`（預設值：`on-miss`）
- `tools.exec.node`（預設值：未設定）
- `tools.exec.pathPrepend`：執行時要加在 `PATH` 前的目錄清單（僅限 gateway 與 sandbox）。
- `tools.exec.safeBins`：僅限 stdin 的安全二進位檔，可在未明確列入允許清單的情況下執行。行為詳情請參考 [Safe bins](/tools/exec-approvals#safe-bins-stdin-only)。
- `tools.exec.safeBinTrustedDirs`：額外明確信任的目錄，用於 `safeBins` 路徑檢查。`PATH` 專案永遠不會自動信任。內建預設為 `/bin` 和 `/usr/bin`。
- `tools.exec.safeBinProfiles`：每個安全二進位檔的可選自訂 argv 政策（`minPositional`、`maxPositional`、`allowedValueFlags`、`deniedFlags`）。

範例：

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### 路徑處理

- `host=gateway`：將您的登入 shell `PATH` 合併到執行環境中。`env.PATH` 的覆寫在主機執行時會被拒絕。守護程序本身仍以最小的 `PATH` 執行：
  - macOS：`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`
  - Linux：`/usr/local/bin`、`/usr/bin`、`/bin`
- `host=sandbox`：在容器內執行 `sh -lc`（登入 shell），因此 `/etc/profile` 可能會重設 `PATH`。OpenClaw 會在透過內部環境變數（無 shell 插值）載入設定檔後，將 `env.PATH` 預先加到前面；`tools.exec.pathPrepend` 在此也適用。
- `host=node`：只有您傳入的非封鎖環境覆寫會被送到節點。`env.PATH` 的覆寫在主機執行時會被拒絕，且節點主機會忽略它們。如果您需要在節點上新增 PATH 專案，請設定節點主機服務環境（systemd/launchd）或將工具安裝在標準位置。

每個代理節點綁定（使用設定中代理列表的索引）：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制介面：Nodes 標籤頁包含一個小型的「執行節點綁定」面板，用於相同的設定。

## 會話覆寫 (`/exec`)

使用 `/exec` 來設定 `host`、`security`、`ask` 和 `node` 的**每會話**預設值。  
傳送不帶參數的 `/exec` 以顯示目前的值。

範例：

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 授權模型

`/exec` 僅對**授權發送者**有效（頻道允許清單／配對加上 `commands.useAccessGroups`）。  
它只更新**會話狀態**，不會寫入設定。若要強制停用 exec，請透過工具政策（`tools.deny: ["exec"]` 或每代理）拒絕。  
除非你明確設定 `security=full` 和 `ask=off`，否則主機批准仍然適用。

## Exec 批准（伴隨應用程式／節點主機）

沙箱代理可要求在 `exec` 在閘道或節點主機執行前，逐次請求批准。  
詳見 [Exec 批准](/tools/exec-approvals) 的政策、允許清單與 UI 流程。

當需要批准時，exec 工具會立即回傳 `status: "approval-pending"` 和批准 ID。  
一旦批准（或拒絕／逾時），閘道會發出系統事件（`Exec finished` / `Exec denied`）。  
若命令在 `tools.exec.approvalRunningNoticeMs` 後仍在執行，會發出單一 `Exec running` 通知。

## 允許清單 + 安全執行檔

手動允許清單強制執行只比對**解析後的二進位路徑**（不比對檔名）。  
當 `security=allowlist` 時，shell 命令僅在每個管線段皆在允許清單或安全執行檔中時自動允許。  
允許清單模式下，串接（`;`、`&&`、`||`）與重導向會被拒絕，除非每個頂層段都符合允許清單（包含安全執行檔）。  
重導向仍不支援。

`autoAllowSkills` 是 exec 批准中的另一個便利路徑，與手動路徑允許清單條目不同。  
若要嚴格明確信任，請保持 `autoAllowSkills` 關閉。

請使用這兩個控制項來處理不同工作：

- `tools.exec.safeBins`：小型、僅限標準輸入的串流過濾器。
- `tools.exec.safeBinTrustedDirs`：安全執行檔路徑的明確額外信任目錄。
- `tools.exec.safeBinProfiles`：自訂安全執行檔的明確 argv 政策。
- 允許清單：對執行檔路徑的明確信任。

請勿將 `safeBins` 視為通用允許清單，且不要加入直譯器／執行時二進位（例如 `python3`、`node`、`ruby`、`bash`）。  
若需要這些，請使用明確允許清單條目並保持批准提示啟用。  
`openclaw security audit` 會在直譯器／執行時 `safeBins` 條目缺少明確設定檔時發出警告，`openclaw doctor --fix` 可協助建立缺少的自訂 `safeBinProfiles` 條目。

完整的政策細節與範例，請參考 [執行批准](/tools/exec-approvals#safe-bins-stdin-only) 以及 [安全執行檔與允許清單比較](/tools/exec-approvals#safe-bins-versus-allowlist)。

## 範例

前景執行：

```json
{ "tool": "exec", "command": "ls -la" }
```

背景執行 + 輪詢：

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

傳送按鍵（tmux 風格）：

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

提交（僅傳送換行符）：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

貼上（預設使用括號包裹）：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch（實驗性功能）

`apply_patch` 是 `exec` 的子工具，用於結構化的多檔案編輯。
請明確啟用此功能：

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, workspaceOnly: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

說明：

- 僅適用於 OpenAI/OpenAI Codex 模型。
- 工具政策仍然適用；`allow: ["exec"]` 隱含允許 `apply_patch`。
- 設定位於 `tools.exec.applyPatch`。
- `tools.exec.applyPatch.workspaceOnly` 預設為 `true`（工作區內）。只有在您有意讓 `apply_patch` 在工作區目錄外寫入/刪除時，才將其設為 `false`。
