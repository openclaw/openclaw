---
summary: "執行工具的使用方式、標準輸入模式和 TTY 支援"
read_when:
  - 使用或修改執行工具時
  - 偵錯標準輸入或 TTY 行為時
title: "執行工具"
---

# 執行工具

在工作區中執行 shell 指令。透過 `process` 支援前景 + 背景執行。
如果 `process` 不被允許，`exec` 將同步執行並忽略 `yieldMs`/`background`。
背景工作階段的範圍限定在每個智慧代理；`process` 僅能看到來自相同智慧代理的工作階段。

## 參數

- `command` (必填)
- `workdir` (預設為當前工作目錄)
- `env` (鍵/值覆寫)
- `yieldMs` (預設 10000): 延遲後自動轉入背景
- `background` (布林值): 立即轉入背景
- `timeout` (秒，預設 1800): 超時後終止
- `pty` (布林值): 在偽終端機中執行（適用於僅支援 TTY 的 CLI、程式設計智慧代理、終端機使用者介面）
- `host` (`sandbox | gateway | node`): 執行位置
- `security` (`deny | allowlist | full`): `gateway`/`node` 的強制執行模式
- `ask` (`off | on-miss | always`): `gateway`/`node` 的核准提示
- `node` (字串): `host=node` 的節點 ID/名稱
- `elevated` (布林值): 請求高權限模式 (Gateway 主機)；`security=full` 僅在高權限解析為 `full` 時強制執行

備註：

- `host` 預設為 `sandbox`。
- 當沙箱隔離關閉時，`elevated` 會被忽略 (exec 已在主機上執行)。
- `gateway`/`node` 的核准由 `~/.openclaw/exec-approvals.json` 控制。
- `node` 需要一個配對的節點 (配套應用程式或無頭節點主機)。
- 如果有多個節點可用，請設定 `exec.node` 或 `tools.exec.node` 來選擇一個。
- 在非 Windows 主機上，如果設定了 `SHELL`，exec 會使用 `SHELL`；如果 `SHELL` 是 `fish`，它會優先從 `PATH` 中選擇 `bash` (或 `sh`) 以避免 fish 不相容的腳本，如果兩者都不存在，則回退到 `SHELL`。
- 主機執行 (`gateway`/`node`) 會拒絕 `env.PATH` 和載入器覆寫 (`LD_*`/`DYLD_*`)，以防止二進位劫持或注入程式碼。
- 重要：沙箱隔離 **預設是關閉的**。如果沙箱隔離關閉，`host=sandbox` 會直接在 Gateway 主機上執行 (無容器)，並且 **不需要核准**。若要啟用核准，請使用 `host=gateway` 並設定 exec 核准 (或啟用沙箱隔離)。

## 設定

- `tools.exec.notifyOnExit` (預設: true): 當為 true 時，背景執行的 exec 工作階段會在退出時將系統事件排入佇列並請求心跳。
- `tools.exec.approvalRunningNoticeMs` (預設: 10000): 當一個受核准控制的 exec 執行時間超過此值時，發出一個單一的「正在執行」通知 (0 禁用)。
- `tools.exec.host` (預設: `sandbox`)
- `tools.exec.security` (預設: `deny` 用於沙箱隔離，`allowlist` 用於未設定的 Gateway + 節點)
- `tools.exec.ask` (預設: `on-miss`)
- `tools.exec.node` (預設: 未設定)
- `tools.exec.pathPrepend`: 要在 exec 執行時，添加到 `PATH` 前面的目錄列表。
- `tools.exec.safeBins`: 無需明確的允許列表條目即可執行的僅標準輸入安全二進位檔案。

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

- `host=gateway`: 將您的登入 shell `PATH` 合併到 exec 環境中。`env.PATH` 覆寫會被主機執行拒絕。Daemon 本身仍以最小的 `PATH` 執行：
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: 在容器內執行 `sh -lc` (登入 shell)，因此 `/etc/profile` 可能會重設 `PATH`。
  OpenClaw 透過內部環境變數 (無 shell 內插) 在 profile 來源設定後將 `env.PATH` 加入前面；
  `tools.exec.pathPrepend` 也適用於此。
- `host=node`: 只有您傳遞的非封鎖環境覆寫會傳送至節點。`env.PATH` 覆寫會被主機執行拒絕。無頭節點主機僅在 `PATH` 預先加到節點主機 `PATH` 時 (不替換) 才接受 `PATH`。macOS 節點完全會捨棄 `PATH` 覆寫。

每個智慧代理的節點綁定 (在設定中使用智慧代理列表索引)：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

控制使用者介面：節點分頁包含一個小型的「執行節點綁定」面板，用於相同的設定。

## 工作階段覆寫 (`/exec`)

使用 `/exec` 為 `host`、`security`、`ask` 和 `node` 設定**每個工作階段**的預設值。
傳送 `/exec` 不帶任何參數以顯示當前值。

範例：

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## 授權模型

`/exec` 僅適用於**授權的傳送者** (頻道允許列表/配對以及 `commands.useAccessGroups`)。
它僅更新**工作階段狀態**，不寫入設定。若要硬性停用 exec，請透過工具策略拒絕它 (`tools.deny: ["exec"]` 或每個智慧代理)。主機核准仍然適用，除非您明確設定 `security=full` 和 `ask=off`。

## Exec 核准 (配套應用程式 / 節點主機)

沙箱隔離的智慧代理可能在 Gateway 或節點主機上執行 `exec` 之前需要每個請求的核准。
請參閱 [Exec 核准](/tools/exec-approvals) 以了解策略、允許列表和使用者介面流程。

當需要核准時，exec 工具會立即傳回
`status: "approval-pending"` 和一個核准 ID。一旦核准 (或拒絕 / 超時)，
Gateway 會發出系統事件 (`Exec finished` / `Exec denied`)。如果指令在 `tools.exec.approvalRunningNoticeMs` 後仍在執行，則會發出一個單一的 `Exec running` 通知。

## 允許列表 + 安全二進位檔案

允許列表強制執行僅匹配**已解析的二進位檔案路徑** (不匹配基本名稱)。當
`security=allowlist` 時，shell 指令僅在每個管線段都位於允許列表或為安全二進位檔案時才自動允許。在允許列表模式下，鏈接 (`;`、`&&`、`||`) 和重定向會被拒絕。

## 範例

前景：

```json
{ "tool": "exec", "command": "ls -la" }
```

背景 + 輪詢：

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

傳送按鍵 (tmux 樣式)：

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

提交 (僅傳送歸位字元)：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

貼上 (預設為括號)：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (實驗性)

`apply_patch` 是 `exec` 的子工具，用於結構化的多檔案編輯。
明確啟用它：

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

備註：

- 僅適用於 OpenAI/OpenAI Codex 模型。
- 工具策略仍然適用；`allow: ["exec"]` 隱含允許 `apply_patch`。
- 設定位於 `tools.exec.applyPatch` 下。
