---
summary: "Exec 工具的使用方式、stdin 模式及 TTY 支援"
read_when:
  - 使用或修改 exec 工具時
  - 調試 stdin 或 TTY 行為時
title: "Exec 工具"
---

# Exec 工具

在工作區運行 shell 指令。支援透過 `process` 進行前景與背景執行。
如果 `process` 被禁用，`exec` 將以同步方式運行，並忽略 `yieldMs`/`background`。
背景工作階段的範圍限定於各個智慧代理；`process` 只能看到來自同一個智慧代理的工作階段。

## 參數

- `command` (必填)
- `workdir` (預設為目前的目錄 cwd)
- `env` (鍵值對覆寫)
- `yieldMs` (預設 10000)：延遲後自動轉入背景
- `background` (布林值)：立即進入背景執行
- `timeout` (秒，預設 1800)：過期時終止
- `pty` (布林值)：可用時在虛擬終端機 (pseudo-terminal) 中運行 (僅限 TTY 的 CLI、程式碼智慧代理、終端機 UI)
- `host` (`sandbox | gateway | node`)：執行位置
- `security` (`deny | allowlist | full`)：`gateway`/`node` 的強制執行模式
- `ask` (`off | on-miss | always`)：`gateway`/`node` 的核准提示
- `node` (字串)：`host=node` 時的節點 ID 或名稱
- `elevated` (布林值)：請求高階模式 (Gateway 主機)；僅當 elevated 解析為 `full` 時，才會強制執行 `security=full`

注意事項：

- `host` 預設為 `sandbox`。
- 當沙箱隔離關閉時 (exec 已在主機上運行)，會忽略 `elevated`。
- `gateway`/`node` 的核准由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要配對的節點 (配套應用或 headless 節點主機)。
- 如果有多個可用節點，請設定 `exec.node` 或 `tools.exec.node` 來選取一個。
- 在非 Windows 主機上，若已設定 `SHELL` 則 exec 會使用該變數；若 `SHELL` 為 `fish`，它會優先從 `PATH` 中選取 `bash` (或 `sh`) 以避免不相容 fish 的指令碼，若兩者皆不存在，則回退到 `SHELL`。
- 主機執行 (`gateway`/`node`) 會拒絕 `env.PATH` 和載入器覆寫 (`LD_*`/`DYLD_*`)，以防止二進制檔案劫持或程式碼注入。
- 重要：沙箱隔離**預設為關閉**。若沙箱隔離已關閉，`host=sandbox` 將直接在 Gateway 主機上運行 (無容器) 且**不需要核准**。若要要求核准，請使用 `host=gateway` 運行並設定 exec 核准 (或啟用沙箱隔離)。

## 設定

- `tools.exec.notifyOnExit` (預設：true)：為 true 時，背景執行的 exec 工作階段會在結束時將系統事件排入佇列並在結束時請求心跳。
- `tools.exec.approvalRunningNoticeMs` (預設：10000)：當受核准限制的 exec 運行時間超過此值時，發出一次「運行中」通知 (0 代表禁用)。
- `tools.exec.host` (預設：`sandbox`)
- `tools.exec.security` (預設：sandbox 為 `deny`，未設定時 gateway + node 為 `allowlist`)
- `tools.exec.ask` (預設：`on-miss`)
- `tools.exec.node` (預設：未設定)
- `tools.exec.pathPrepend`：要附加在 exec 執行時 `PATH` 前方的目錄清單。
- `tools.exec.safeBins`：僅限 stdin 的安全二進制檔案，無需明確的允許清單項目即可運行。

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

### PATH 處理

- `host=gateway`：將您的登入 shell `PATH` 合併到 exec 環境中。主機執行會拒絕 `env.PATH` 覆寫。守護行程 (daemon) 本身仍以最小化 `PATH` 運行：
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`：在容器內運行 `sh -lc` (登入 shell)，因此 `/etc/profile` 可能會重設 `PATH`。OpenClaw 在載入設定檔 (profile) 後透過內部環境變數附加 `env.PATH` (無 shell 插值)；`tools.exec.pathPrepend` 也適用於此。
- `host=node`：只有您傳遞且未被阻擋的環境變數覆寫會被發送到節點。主機執行會拒絕 `env.PATH` 覆寫。Headless 節點主機僅接受附加在節點主機 `PATH` 前方的路徑 (不允許替換)。macOS 節點會完全捨棄 `PATH` 覆寫。

個別智慧代理節點綁定 (在設定中使用智慧代理列表索引)：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制 UI：節點 (Nodes) 分頁包含一個小型「Exec 節點綁定」面板，可用於相同的設定。

## 工作階段覆寫 (`/exec`)

使用 `/exec` 來設定**各工作階段**專用的 `host`、`security`、`ask` 和 `node` 預設值。
發送不帶參數的 `/exec` 以顯示目前數值。

範例：

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 授權模型

`/exec` 僅對**經授權的發送者**有效 (頻道允許清單/配對加上 `commands.useAccessGroups`)。
它僅更新**工作階段狀態**，不會寫入設定檔案。若要強制禁用 exec，請透過工具策略 (`tools.deny: ["exec"]` 或針對個別智慧代理) 進行禁止。除非您明確設定 `security=full` 且 `ask=off`，否則主機核准仍會生效。

## Exec 核准 (配套應用 / 節點主機)

沙箱隔離的智慧代理在 Gateway 或節點主機上執行 `exec` 前，可以要求逐次請求核准。
請參閱 [Exec 核准](/tools/exec-approvals) 了解相關策略、允許清單和 UI 流程。

當需要核准時，exec 工具會立即回傳 `status: "approval-pending"` 和核准 ID。一旦核准 (或拒絕 / 超時)，Gateway 會發出系統事件 (`Exec finished` / `Exec denied`)。如果指令在 `tools.exec.approvalRunningNoticeMs` 後仍在運行，則會發出一次 `Exec running` 通知。

## 允許清單 + 安全二進制檔案

允許清單的強制執行僅匹配**解析後的二進制檔案路徑** (不進行基本名稱匹配)。當 `security=allowlist` 時，僅當管線 (pipeline) 的每個片段都位於允許清單中或屬於安全二進制檔案時，shell 指令才會被自動允許。在允許清單模式下，連鎖指令 (`;`, `&&`, `||`) 和重新導向將會被拒絕。

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

發送按鍵 (tmux 風格)：

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

提交 (僅發送換行 CR)：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

貼上 (預設使用括號模式 bracketed)：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (實驗性)

`apply_patch` 是 `exec` 的子工具，用於結構化的多檔案編輯。
請明確啟用它：

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

注意事項：

- 僅適用於 OpenAI/OpenAI Codex 模型。
- 工具策略仍然適用；`allow: ["exec"]` 會隱含地允許 `apply_patch`。
- 設定位於 `tools.exec.applyPatch` 下。
