---
summary: "Exec 核准、允許清單與沙箱逃逸提示"
read_when:
  - 正在配置 Exec 核准或允許清單
  - 在 macOS 應用程式中實作 Exec 核准 UX
  - 審查沙箱逃逸提示及其影響
title: "Exec 核准"
---

# Exec 核准

Exec 核准是 **配套應用 / node host 的護欄**，用於允許受沙箱隔離的智慧代理在真實主機（Gateway 或 node）上執行指令。可以將其視為安全連鎖裝置：只有當政策 + 允許清單 +（選用的）使用者核准全部達成一致時，才允許執行指令。
Exec 核准是工具政策和特權限制之**外**的額外機制（除非特權限制設定為 `full`，這會跳過核准）。
有效政策會採用 `tools.exec.*` 與核准預設值中較**嚴格**的一個；如果省略了核准欄位，則會使用 `tools.exec` 的值。

如果配套應用的 UI **不可用**，任何需要提示的請求都將由 **詢問備援**（預設：拒絕）來處理。

## 適用範圍

Exec 核准是在執行主機上本機強制執行的：

- **gateway 主機** → Gateway 機器上的 `openclaw` 程序
- **node 主機** → node runner（macOS 配套應用或無介面 node host）

macOS 分離：

- **node host 服務**透過本機 IPC 將 `system.run` 轉發到 **macOS 應用程式**。
- **macOS 應用程式**強制執行核准，並在 UI 環境中執行指令。

## 設定與儲存

核准資訊儲存在執行主機上的本機 JSON 檔案中：

`~/.openclaw/exec-approvals.json`

結構範例：

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## 政策調整項

### 安全性 (`exec.security`)

- **deny**: 封鎖所有主機執行請求。
- **allowlist**: 僅允許在允許清單中的指令。
- **full**: 允許所有操作（等同於特權模式）。

### 詢問 (`exec.ask`)

- **off**: 永不提示。
- **on-miss**: 僅在不符合允許清單時提示。
- **always**: 每個指令都提示。

### 詢問備援 (`askFallback`)

如果需要提示但無法連接 UI，則由備援決定：

- **deny**: 封鎖。
- **allowlist**: 僅在符合允許清單時允許。
- **full**: 允許。

## 允許清單（針對每個智慧代理）

允許清單是**針對每個智慧代理**設定的。如果存在多個智慧代理，請在 macOS 應用程式中切換您正在編輯的智慧代理。模式採用**不區分大小寫的 glob 匹配**。
模式應解析為**二進制路徑**（僅包含主檔名的項目會被忽略）。
舊版的 `agents.default` 項目在載入時會遷移至 `agents.main`。

範例：

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

每個允許清單項目會追蹤：

- **id** 用於 UI 識別的穩定 UUID（選填）
- **last used** 最後使用時間戳記
- **last used command** 最後使用的指令
- **last resolved path** 最後解析的路徑

## 自動允許 Skills CLI

啟用 **自動允許 Skills CLI** 時，已知 Skills 所引用的執行檔在 node（macOS node 或無介面 node host）上會被視為已加入允許清單。這會透過 Gateway RPC 使用 `skills.bins` 來獲取 Skill 二進制檔清單。如果您想要嚴格的手動允許清單，請停用此功能。

## 安全二進制檔 (僅限 stdin)

`tools.exec.safeBins` 定義了一小部分**僅限 stdin** 的二進制檔（例如 `jq`），它們可以在允許清單模式下執行，**無需**明確的允許清單項目。安全二進制檔會拒絕位置檔案參數和路徑類的權杖，因此它們只能對傳入的串流進行操作。
在允許清單模式下，Shell 鏈接和重導向不會被自動允許。

當每個頂層片段（包括安全二進制檔或自動允許的 Skill）都符合允許清單時，即允許使用 Shell 鏈接（`&&`、`||`、`;`）。允許清單模式仍不支援重導向。
指令替換（`$()` / 反引號）在解析允許清單期間會被拒絕，包括在雙引號內；如果您需要字面上的 `$()` 文字，請使用單引號。

預設安全二進制檔：`jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`。

## 使用控制 UI 編輯

使用 **控制 UI → Nodes → Exec approvals** 卡片來編輯預設值、各別智慧代理的覆寫以及允許清單。選擇範圍（預設或某個智慧代理）、調整政策、新增/移除允許清單模式，然後點擊 **Save**（儲存）。UI 會顯示每個模式的 **last used**（最後使用）元數據，以便您保持清單整潔。

目標選擇器可選擇 **Gateway**（本機核准）或 **Node**。Node 必須宣告 `system.execApprovals.get/set`（macOS 應用程式或無介面 node host）。
如果 Node 尚未宣告 Exec 核准功能，請直接編輯其本機的 `~/.openclaw/exec-approvals.json`。

CLI：`openclaw approvals` 支援 Gateway 或 Node 編輯（請參閱 [Approvals CLI](/cli/approvals)）。

## 核准流程

當需要提示時，Gateway 會向操作者用戶端廣播 `exec.approval.requested`。
控制 UI 和 macOS 應用程式透過 `exec.approval.resolve` 進行解析，然後 Gateway 將核准的請求轉發給 node host。

當需要核准時，Exec 工具會立即回傳一個核准 ID。使用該 ID 可關聯稍後的系統事件（`Exec finished` / `Exec denied`）。如果在逾時前未達成決定，請求將被視為核准逾時，並顯示為拒絕原因。

確認對話方塊包含：

- 指令 + 參數
- cwd (目前工作目錄)
- 智慧代理 ID
- 解析後的執行檔路徑
- 主機 + 政策元數據

操作：

- **Allow once** (允許一次) → 立即執行
- **Always allow** (一律允許) → 加入允許清單並執行
- **Deny** (拒絕) → 封鎖

## 核准轉發至聊天頻道

您可以將 Exec 核准提示轉發到任何聊天頻道（包括外掛程式頻道），並使用 `/approve` 進行核准。這使用標準的出站遞送管道。

設定：

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // 子字串或正規表達式
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

在聊天中回覆：

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC 流程

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + 核准 + system.run)
```

安全說明：

- Unix socket 模式為 `0600`，權杖儲存在 `exec-approvals.json`。
- 相同 UID 對等檢查。
- 挑戰/回應（nonce + HMAC 權杖 + 請求雜湊值）+ 短 TTL。

## 系統事件

Exec 生命週期會以系統訊息的形式呈現：

- `Exec running`（僅當指令執行時間超過通知閾值時）
- `Exec finished`
- `Exec denied`

這些訊息會在 node 回報事件後發布到智慧代理的工作階段中。
Gateway 主機的 Exec 核准在指令完成時（以及選擇性地在執行時間超過閾值時）也會發出相同的生命週期事件。
受核准限制的 Exec 會重用核准 ID 作為這些訊息中的 `runId`，以便於關聯。

## 影響

- **full** 功能強大；請盡可能優先使用允許清單。
- **ask** 讓您隨時掌握動態，同時仍允許快速核准。
- 針對每個智慧代理的允許清單可防止一個智慧代理的核准洩露到其他智慧代理中。
- 核准僅適用於來自 **授權發送者** 的主機執行請求。未授權的發送者無法發出 `/exec`。
- `/exec security=full` 是為授權操作者提供的對談級便利功能，依設計會跳過核准。
  若要強制封鎖主機執行，請將核准安全性設定為 `deny` 或透過工具政策拒絕 `exec` 工具。

相關內容：

- [Exec 工具](/tools/exec)
- [特權模式](/tools/elevated)
- [Skills](/tools/skills)
