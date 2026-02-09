---
summary: "Exec 核准、允許清單，以及沙箱逃逸提示"
read_when:
  - 設定 Exec 核准或允許清單
  - 在 macOS 應用程式中實作 Exec 核准 UX
  - 檢視沙箱逃逸提示與其影響
title: "Exec 核准"
---

# Exec 核准

2. Exec 核准是**伴生應用程式 / 節點主機護欄**，用來允許沙箱化代理在真實主機（`gateway` 或 `node`）上執行指令。 Think of it like a safety interlock:
   commands are allowed only when policy + allowlist + (optional) user approval all agree.
   Exec approvals are **in addition** to tool policy and elevated gating (unless elevated is set to `full`, which skips approvals).
3. 實際生效的政策是 `tools.exec.*` 與核准預設值中**較嚴格**者；如果省略某個核准欄位，則使用 `tools.exec` 的值。

6. 如果**伴生應用程式 UI 無法使用**，任何需要提示的請求都會由 **ask 後備機制** 處理（預設：拒絕）。

## 7. 適用範圍

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
- 8. **on-miss**：僅在允許清單未匹配時才提示。
- **always**：每個命令都提示。

### Ask fallback（`askFallback`）

若需要提示但無任何 UI 可連線，fallback 的決策為：

- **deny**：封鎖。
- **allowlist**：僅在允許清單命中時允許。
- **full**：允許。

## 允許清單（每個代理程式）

9. 允許清單是**以代理為單位**。 10. 如果存在多個代理，請在 macOS 應用程式中切換你正在編輯的代理。 11. 模式為**不區分大小寫的 glob 比對**。
10. 模式應解析為**二進位路徑**（僅檔名的項目會被忽略）。
11. 舊版 `agents.default` 項目在載入時會遷移到 `agents.main`。

範例：

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

14. 每個允許清單項目會追蹤：

- **id**：用於 UI 身分識別的穩定 UUID（選用）
- **last used**：最後使用時間戳記
- **last used command**
- **last resolved path**

## 自動允許 Skills CLI

15. 啟用 **Auto-allow skill CLIs** 時，已知技能所引用的可執行檔會在節點上視為已加入允許清單（macOS 節點或無頭節點主機）。 16. 這會透過 Gateway RPC 使用 `skills.bins` 來取得技能二進位清單。 17. 如果你想要嚴格的手動允許清單，請停用此功能。

## 安全 bin（僅 stdin）

18. `tools.exec.safeBins` 定義了一小組**僅 stdin** 的二進位檔（例如 `jq`），可在允許清單模式下**不需**明確的允許清單項目即可執行。 19. Safe bins 會拒絕位置式檔案參數與類似路徑的權杖，因此它們只能操作傳入的串流。
19. 在允許清單模式下，不會自動允許 shell 串接與重新導向。

21. 當每個頂層區段都符合允許清單（包含 safe bins 或技能自動允許）時，才允許 shell 串接（`&&`、`||`、`;`）。 22. 在允許清單模式下仍不支援重新導向。
22. 在允許清單解析期間會拒絕指令替換（`$()` / 反引號），即使在雙引號內也是如此；若需要字面上的 `$()` 文字，請使用單引號。

預設安全 bin：`jq`、`grep`、`cut`、`sort`、`uniq`、`head`、`tail`、`tr`、`wc`。

## 控制 UI 編輯

24. 使用 **Control UI → Nodes → Exec approvals** 卡片來編輯預設值、每代理覆寫與允許清單。 25. 選擇一個範圍（預設值或某個代理），調整政策，新增/移除允許清單模式，然後按 **Save**。 26. UI 會顯示每個模式的**最近使用**中繼資料，方便你保持清單整潔。

27. 目標選擇器可選擇 **Gateway**（本機核准）或 **Node**。 28. 節點必須宣告 `system.execApprovals.get/set`（macOS 應用程式或無頭節點主機）。
28. 如果節點尚未宣告 exec 核准，請直接編輯其本機的 `~/.openclaw/exec-approvals.json`。

CLI：`openclaw approvals` 支援 Gateway 或 Node 的編輯（請參閱 [Approvals CLI](/cli/approvals)）。

## 30. 核准流程

當需要提示時，Gateway 會向操作員用戶端廣播 `exec.approval.requested`。
Control UI 與 macOS 應用程式會透過 `exec.approval.resolve` 進行處理，接著 Gateway 會將
已核准的請求轉送至節點主機。
31. Control UI 與 macOS 應用程式會透過 `exec.approval.resolve` 進行處理，然後 gateway 會將已核准的請求轉送至節點主機。

32. 當需要核准時，exec 工具會立即回傳一個核准 id。 33. 使用該 id 來關聯後續的系統事件（`Exec finished` / `Exec denied`）。 34. 如果在逾時前沒有收到決策，該請求會被視為核准逾時，並以拒絕原因呈現。

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

35. 你可以將 exec 核准提示轉送到任何聊天頻道（包含外掛頻道），並使用 `/approve` 進行核准。 36. 這會使用一般的對外傳遞管線。

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

37. 這些事件會在節點回報後張貼到代理的工作階段中。
38. Gateway 主機上的 exec 核准在指令完成時（以及可選地在執行時間超過門檻時）會發出相同的生命週期事件。
39. 受核准門控的 exec 會在這些訊息中重用核准 id 作為 `runId`，以便輕鬆關聯。

## 40. 影響

- 41. **full** 很強大；能用允許清單時請優先使用。
- 42. **ask** 讓你隨時掌握，同時仍可快速核准。
- 每個代理程式的允許清單可防止某一代理程式的核准外洩到其他代理程式。
- 43. 核准僅適用於來自**已授權傳送者**的主機 exec 請求。 Unauthorized senders cannot issue `/exec`.
- `/exec security=full` is a session-level convenience for authorized operators and skips approvals by design.
  To hard-block host exec, set approvals security to `deny` or deny the `exec` tool via tool policy.

Related:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
