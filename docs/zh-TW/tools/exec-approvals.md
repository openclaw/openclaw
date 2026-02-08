---
summary: "Exec 核准、允許清單，以及沙箱逃逸提示"
read_when:
  - 設定 Exec 核准或允許清單
  - 在 macOS 應用程式中實作 Exec 核准 UX
  - 檢視沙箱逃逸提示與其影響
title: "Exec 核准"
x-i18n:
  source_path: tools/exec-approvals.md
  source_hash: 66630b5d79671dd4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:47Z
---

# Exec 核准

Exec 核准是 **配套應用程式 / 節點主機防護欄**，用於允許沙箱化的代理程式在真實主機上執行命令
（`gateway` 或 `node`）。可將其視為一個安全互鎖：
只有在「政策 + 允許清單 +（選用）使用者核准」全部同意時，命令才會被允許。
Exec 核准是 **額外** 加在工具政策與 elevated 門檻之上（除非 elevated 設為 `full`，此時會略過核准）。
有效政策取 `tools.exec.*` 與核准預設值中 **較嚴格者**；若省略某個核准欄位，則使用 `tools.exec` 的值。

若配套應用程式 UI **不可用**，任何需要提示的請求
會由 **ask fallback** 處理（預設：拒絕）。

## 適用範圍

Exec 核准會在執行主機本地端強制套用：

- **gateway host** → 閘道器機器上的 `openclaw` 程序
- **node host** → 節點執行器（macOS 配套應用程式或無頭節點主機）

macOS 分流：

- **node host service** 透過本地 IPC 將 `system.run` 轉送至 **macOS 應用程式**。
- **macOS 應用程式** 施行核准並在 UI 情境中執行命令。

## 設定與儲存

核准設定會存放在執行主機上的本地 JSON 檔案中：

`~/.openclaw/exec-approvals.json`

範例結構描述：

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

## 政策旋鈕

### Security（`exec.security`）

- **deny**：封鎖所有主機 exec 請求。
- **allowlist**：僅允許在允許清單中的命令。
- **full**：允許一切（等同於 elevated）。

### Ask（`exec.ask`）

- **off**：永不提示。
- **on-miss**：僅在允許清單未命中時提示。
- **always**：每個命令都提示。

### Ask fallback（`askFallback`）

若需要提示但無任何 UI 可連線，fallback 的決策為：

- **deny**：封鎖。
- **allowlist**：僅在允許清單命中時允許。
- **full**：允許。

## 允許清單（每個代理程式）

允許清單是 **每個代理程式** 各自獨立。若存在多個代理程式，請在 macOS 應用程式中切換正在編輯的代理程式。
比對模式為 **不區分大小寫的 glob**。模式應解析為 **二進位檔路徑**（僅檔名的項目會被忽略）。
舊版的 `agents.default` 項目會在載入時移轉為 `agents.main`。

範例：

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

每個允許清單項目會追蹤：

- **id**：用於 UI 身分識別的穩定 UUID（選用）
- **last used**：最後使用時間戳記
- **last used command**
- **last resolved path**

## 自動允許 Skills CLI

啟用 **Auto-allow skill CLIs** 後，已知 Skills 所引用的可執行檔
會在節點（macOS 節點或無頭節點主機）上視為已列入允許清單。此功能會透過 Gateway RPC 使用
`skills.bins` 來取得 skill 的 bin 清單。若你希望嚴格採用手動允許清單，請停用此功能。

## 安全 bin（僅 stdin）

`tools.exec.safeBins` 定義了一小組 **僅 stdin** 的二進位檔（例如 `jq`），
在允許清單模式下 **不需要** 明確的允許清單項目即可執行。安全 bin 會拒絕
位置式檔案引數與類路徑權杖，因此只能對輸入串流進行操作。
在允許清單模式下，不會自動允許 shell 串接與重新導向。

當每個最上層區段都符合允許清單（包含安全 bin 或 Skill 自動允許）時，
允許 shell 串接（`&&`、`||`、`;`）。
在允許清單模式下，重新導向仍不支援。
在允許清單解析期間會拒絕命令替換（`$()` / 反引號），即使在
雙引號內亦然；若需要字面上的 `$()` 文字，請使用單引號。

預設安全 bin：`jq`、`grep`、`cut`、`sort`、`uniq`、`head`、`tail`、`tr`、`wc`。

## 控制 UI 編輯

使用 **Control UI → Nodes → Exec 核准** 卡片來編輯預設值、每個代理程式的
覆寫設定，以及允許清單。選擇一個範圍（預設或某個代理程式），調整政策，
新增／移除允許清單模式，然後按下 **Save**。UI 會顯示每個模式的 **last used**
中繼資料，協助你保持清單整潔。

目標選擇器可選 **Gateway**（本地核准）或 **Node**。節點
必須宣告 `system.execApprovals.get/set`（macOS 應用程式或無頭節點主機）。
若某節點尚未宣告 exec 核准，請直接編輯其本地
`~/.openclaw/exec-approvals.json`。

CLI：`openclaw approvals` 支援 Gateway 或 Node 的編輯（請參閱 [Approvals CLI](/cli/approvals)）。

## 核准流程

當需要提示時，Gateway 會向操作員用戶端廣播 `exec.approval.requested`。
Control UI 與 macOS 應用程式會透過 `exec.approval.resolve` 進行處理，接著 Gateway 會將
已核准的請求轉送至節點主機。

當需要核准時，exec 工具會立即回傳一個核准 id。請使用該 id 來
關聯後續的系統事件（`Exec finished` / `Exec denied`）。
若在逾時前未收到決策，該請求會被視為核准逾時，並以拒絕理由呈現。

確認對話框包含：

- 命令 + 引數
- cwd
- agent id
- 已解析的可執行檔路徑
- 主機 + 政策中繼資料

動作：

- **Allow once** → 立即執行
- **Always allow** → 加入允許清單並執行
- **Deny** → 封鎖

## 將核准轉送至聊天頻道

你可以將 exec 核准提示轉送到任何聊天頻道（包含外掛頻道），並以
`/approve` 進行核准。此功能使用一般的對外傳遞管線。

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

安全性注意事項：

- Unix socket 模式 `0600`，權杖儲存在 `exec-approvals.json`。
- 相同 UID 的對等端檢查。
- 挑戰／回應（nonce + HMAC 權杖 + 請求雜湊）+ 短 TTL。

## 系統事件

Exec 生命週期會以系統訊息呈現：

- `Exec running`（僅當命令超過執行中通知門檻時）
- `Exec finished`
- `Exec denied`

這些訊息會在節點回報事件後張貼至代理程式的工作階段。
Gateway 主機上的 exec 核准在命令完成時（以及可選地在執行時間超過門檻時）
也會發出相同的生命週期事件。
受核准門檻管控的 exec 會在這些訊息中重用核准 id 作為 `runId`，以利關聯。

## 影響

- **full** 權限強大；能用允許清單時請優先使用。
- **ask** 能讓你持續掌握狀況，同時仍可快速核准。
- 每個代理程式的允許清單可防止某一代理程式的核准外洩到其他代理程式。
- 核准僅適用於來自 **authorized senders** 的主機 exec 請求。未授權的寄件者無法發出 `/exec`。
- `/exec security=full` 是為已授權操作員提供的工作階段層級便利功能，且設計上會略過核准。
  若要硬性封鎖主機 exec，請將核准安全性設為 `deny`，或在工具政策中拒絕 `exec` 工具。

相關：

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
