---
summary: "執行批准、允許清單和沙箱逃逸提示"
read_when:
  - 設定執行批准或允許清單
  - 在 macOS 應用程式中實作執行批准使用者體驗
  - 審查沙箱逃逸提示和影響
title: "執行批准"
---

# 執行批准

執行批准是**配套應用程式 / 節點主機的防護措施**，用於讓沙箱隔離的智慧代理在真實主機（Gateway 或節點）上執行指令。將其視為一種安全聯鎖：僅當政策 + 允許清單 + (選填) 使用者批准全部同意時，才允許執行指令。執行批准**額外**於工具政策和權限提升的控管（除非權限提升設定為 `full`，這會跳過批准）。有效的政策是 `tools.exec.*` 和批准預設值中**更嚴格**的一項；如果批准欄位被省略，則使用 `tools.exec` 的值。

如果配套應用程式 UI **不可用**，任何需要提示的請求都將由**詢問備援**（預設：拒絕）來解決。

## 適用範圍

執行批准在執行主機上本地強制執行：

- **Gateway 主機** → Gateway 機器上的 `openclaw` 程式
- **節點主機** → 節點執行程式 (macOS 配套應用程式或無頭節點主機)

macOS 分割：

- **節點主機服務**透過本地 IPC 將 `system.run` 轉發到 **macOS 應用程式**。
- **macOS 應用程式**強制執行批准 + 在 UI 環境中執行指令。

## 設定和儲存

批准儲存在執行主機上的本地 JSON 檔案中：

`~/.openclaw/exec-approvals.json`

範例結構：

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

## 政策設定

### 安全性 (`exec.security`)

- **deny**：阻止所有主機執行請求。
- **allowlist**：僅允許允許清單中的指令。
- **full**：允許所有指令（等同於權限提升）。

### 詢問 (`exec.ask`)

- **off**：從不提示。
- **on-miss**：僅當允許清單不匹配時提示。
- **always**：每次執行指令時都提示。

### 詢問備援 (`askFallback`)

如果需要提示但無法連接到 UI，備援決定：

- **deny**：阻止。
- **allowlist**：僅當允許清單匹配時允許。
- **full**：允許。

## 允許清單 (每個智慧代理)

允許清單是**每個智慧代理**獨立的。如果有多個智慧代理，請在 macOS 應用程式中切換您要編輯的智慧代理。模式是**不區分大小寫的 Glob 匹配**。模式應解析為**二進位檔案路徑**（僅基礎名稱的條目將被忽略）。舊版的 `agents.default` 條目將在載入時遷移到 `agents.main`。

範例：

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

每個允許清單條目追蹤：

- **id** 穩定 UUID 用於 UI 身份 (選填)
- **last used** 時間戳記
- **last used command**
- **last resolved path**

## 自動允許技能 CLI

啟用**自動允許技能 CLI** 時，已知技能引用的可執行檔案將被視為節點（macOS 節點或無頭節點主機）上允許清單中的項目。這透過 Gateway RPC 使用 `skills.bins` 來獲取技能二進位檔案清單。如果您需要嚴格的手動允許清單，請停用此功能。

## 安全二進位檔案 (僅限 stdin)

`tools.exec.safeBins` 定義了一小部分**僅限 stdin** 的二進位檔案（例如 `jq`），它們可以在允許清單模式下執行，**無需**明確的允許清單條目。安全二進位檔案拒絕位置檔案參數和類似路徑的標記，因此它們只能對輸入串流進行操作。在允許清單模式下，shell 串聯和重定向不會自動允許。

當每個頂層片段都滿足允許清單（包括安全二進位檔案或技能自動允許）時，允許 shell 串聯（`&&`、`||`、`;`）。重定向在允許清單模式下仍不受支援。在允許清單解析期間，指令替換（`$()` / 反引號）將被拒絕，包括在雙引號內部；如果需要字面上的 `$()` 文字，請使用單引號。

預設的安全二進位檔案：`jq`、`grep`、`cut`、`sort`、`uniq`、`head`、`tail`、`tr`、`wc`。

## 控制 UI 編輯

使用**控制 UI → 節點 → 執行批准**卡片來編輯預設值、每個智慧代理的覆蓋設定和允許清單。選擇一個範圍（預設值或智慧代理），調整政策，新增/移除允許清單模式，然後**儲存**。UI 顯示每個模式的**最後使用**中繼資料，以便您可以保持清單整潔。

目標選擇器選擇 **Gateway**（本地批准）或**節點**。節點必須通告 `system.execApprovals.get/set`（macOS 應用程式或無頭節點主機）。如果節點尚未通告執行批准，請直接編輯其本地 `~/.openclaw/exec-approvals.json`。

CLI：`openclaw approvals` 支援 Gateway 或節點編輯（請參閱 [批准 CLI](/cli/approvals)）。

## 批准流程

當需要提示時，Gateway 會向操作員用戶端廣播 `exec.approval.requested`。控制 UI 和 macOS 應用程式透過 `exec.approval.resolve` 解決它，然後 Gateway 將批准的請求轉發到節點主機。

當需要批准時，執行工具會立即返回一個批准 ID。使用該 ID 關聯後續的系統事件（`Exec finished` / `Exec denied`）。如果在逾時之前沒有做出決定，該請求將被視為批准逾時，並顯示為拒絕原因。

確認對話框包含：

- 指令 + 參數
- cwd
- 智慧代理 ID
- 已解析的可執行檔路徑
- 主機 + 政策中繼資料

動作：

- **允許一次** → 立即執行
- **總是允許** → 添加到允許清單 + 執行
- **拒絕** → 阻止

## 將批准轉發到聊天頻道

您可以將執行批准提示轉發到任何聊天頻道（包括外掛程式頻道），並使用 `/approve` 進行批准。這使用正常的出站傳送管線。

設定：

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
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
             Mac App (UI + approvals + system.run)
```

安全注意事項：

- Unix socket 模式 `0600`，令牌儲存在 `exec-approvals.json` 中。
- 相同 UID 對等檢查。
- 挑戰/回應（隨機數 + HMAC 令牌 + 請求雜湊）+ 短 TTL。

## 系統事件

執行生命週期將以系統訊息的形式顯示：

- `Exec running` (僅當指令超出執行通知閾值時)
- `Exec finished`
- `Exec denied`

這些訊息將在節點報告事件後發佈到智慧代理的工作階段。Gateway 主機的執行批准在指令完成時（以及可選地在超出閾值時）發出相同的生命週期事件。受批准控管的執行將批准 ID 重複用作這些訊息中的 `runId`，以便於關聯。

## 影響

- **full** 功能強大；盡可能選擇允許清單。
- **ask** 讓您保持在迴圈中，同時仍允許快速批准。
- 每個智慧代理的允許清單可防止一個智慧代理的批准洩漏到其他智慧代理。
- 批准僅適用於來自**授權傳送者**的主機執行請求。未經授權的傳送者無法發出 `/exec`。
- `/exec security=full` 是授權操作員的工作階段級便利功能，依設計跳過批准。
  要硬性阻止主機執行，請將批准安全性設定為 `deny` 或透過工具政策拒絕 `exec` 工具。

相關：

- [執行工具](/tools/exec)
- [權限提升模式](/tools/elevated)
- [技能](/tools/skills)
