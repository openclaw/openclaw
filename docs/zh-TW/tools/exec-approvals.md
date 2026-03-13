---
summary: "Exec approvals, allowlists, and sandbox escape prompts"
read_when:
  - Configuring exec approvals or allowlists
  - Implementing exec approval UX in the macOS app
  - Reviewing sandbox escape prompts and implications
title: Exec Approvals
---

# 執行批准

執行批准是讓沙盒代理能在真實主機上執行命令的**配套應用程式 / 節點主機護欄**（`gateway` 或 `node`）。可以把它想像成一個安全聯鎖裝置：只有當政策 + 允許清單 +（可選）使用者批准三者皆同意時，命令才被允許執行。執行批准是**額外**的限制，除了工具政策和提升權限的閘道（除非提升權限設定為 `full`，此時會跳過批准）。實際生效的政策是 `tools.exec.*` 與批准預設值中**較嚴格**的那一個；若批准欄位被省略，則使用 `tools.exec` 的值。

如果配套應用程式的 UI **無法使用**，任何需要提示的請求都會由**詢問備援機制**處理（預設：拒絕）。

## 適用範圍

執行批准會在執行主機本地強制執行：

- **閘道主機** → 閘道機器上的 `openclaw` 程式
- **節點主機** → 節點執行器（macOS 配套應用程式或無頭節點主機）

信任模型說明：

- 閘道認證的呼叫者是該閘道的受信任操作員。
- 配對節點將該受信任操作員的能力延伸至節點主機。
- 執行批准降低意外執行的風險，但並非每個使用者的認證邊界。
- 經批准的節點主機執行會綁定標準執行上下文：標準工作目錄、精確的 argv、環境變數綁定（若存在），以及適用時的固定執行檔路徑。
- 對於 shell 腳本及直接呼叫解譯器/執行時檔案，OpenClaw 也會嘗試綁定一個具體的本地檔案操作數。如果該綁定檔案在批准後但執行前被更改，則執行會被拒絕，而非執行已偏移的內容。
- 此檔案綁定是刻意採用盡力而為的方式，並非每個解譯器/執行時載入路徑的完整語意模型。如果批准模式無法精確識別唯一一個具體本地檔案來綁定，則會拒絕產生有批准支援的執行，而非假裝涵蓋完整。

macOS 分流：

- **節點主機服務** 透過本地 IPC 將 `system.run` 轉發給 **macOS 應用程式**。
- **macOS 應用程式** 強制執行批准並在 UI 上下文中執行命令。

## 設定與儲存

批准資料存放於執行主機上的本地 JSON 檔案：

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

## 策略調整選項

### 安全性 (`exec.security`)

- **deny**：封鎖所有主機執行請求。
- **allowlist**：僅允許允許清單中的指令。
- **full**：允許所有操作（等同於提升權限）。

### 提示設定 (`exec.ask`)

- **off**：從不提示。
- **on-miss**：只有在允許清單不匹配時才提示。
- **always**：每次執行指令時都提示。

### 提示回退 (`askFallback`)

若需要提示但無法連接 UI，回退設定決定：

- **deny**：封鎖。
- **allowlist**：僅當允許清單匹配時允許。
- **full**：允許。

## 允許清單（每個代理）

允許清單是**每個代理**獨立設定。若有多個代理，請在 macOS 應用中切換你要編輯的代理。模式為**不區分大小寫的通配符匹配**。模式應解析為**二進位檔案路徑**（僅檔名的條目會被忽略）。舊版 `agents.default` 條目會在載入時轉換為 `agents.main`。

範例：

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

每個允許清單條目會追蹤：

- **id**：用於 UI 識別的穩定 UUID（可選）
- **最後使用時間**：時間戳記
- **最後使用指令**
- **最後解析路徑**

## 自動允許技能 CLI

當啟用 **自動允許技能 CLI** 時，已知技能所參考的可執行檔會被視為在節點（macOS 節點或無頭節點主機）上的允許清單中。此功能透過 `skills.bins` 於 Gateway RPC 取得技能二進位清單。如果您需要嚴格的手動允許清單，請將此功能關閉。

重要的信任說明：

- 這是一個 **隱含的便利允許清單**，與手動路徑允許清單條目分開。
- 適用於 Gateway 與節點位於相同信任邊界的受信任操作環境。
- 若您需要嚴格明確的信任，請保留 `autoAllowSkills: false` 並僅使用手動路徑允許清單條目。

## 安全二進位檔（僅限 stdin）

`tools.exec.safeBins` 定義了一小組 **僅限 stdin** 的二進位檔（例如 `jq`），這些二進位檔可在允許清單模式下執行，**無需** 明確的允許清單條目。安全二進位檔會拒絕位置參數檔案和類路徑的 token，因此它們只能操作輸入的資料流。請將此視為針對串流過濾器的狹義快速通道，而非一般信任清單。  
請 **勿** 將解譯器或執行環境二進位檔（例如 `python3`、`node`、`ruby`、`bash`、`sh`、`zsh`）加入 `safeBins`。  
若指令設計上能評估程式碼、執行子命令或讀取檔案，請優先使用明確的允許清單條目，並保持啟用批准提示。  
自訂安全二進位檔必須在 `tools.exec.safeBinProfiles.<bin>` 中定義明確的設定檔。  
驗證僅根據 argv 形態決定（不檢查主機檔案系統是否存在），避免因允許/拒絕差異而產生檔案存在的推測行為。  
預設安全二進位檔會拒絕檔案導向的選項（例如 `sort -o`、`sort --output`、`sort --files0-from`、`sort --compress-program`、`sort --random-source`、`sort --temporary-directory`/`-T`、`wc --files0-from`、`jq -f/--from-file`、`grep -f/--file`）。  
安全二進位檔也會針對破壞 stdin-only 行為的選項（例如 `sort -o/--output/--compress-program` 和 grep 的遞迴旗標）強制執行每個二進位檔的明確旗標政策。  
在安全二進位檔模式下，長選項會以失敗即封閉（fail-closed）方式驗證：未知旗標和模糊縮寫皆被拒絕。  
安全二進位檔設定檔拒絕的旗標如下：

<!-- SAFE_BIN_DENIED_FLAGS:START -->

- `grep`：`--dereference-recursive`、`--directories`、`--exclude-from`、`--file`、`--recursive`、`-R`、`-d`、`-f`、`-r`
- `jq`：`--argfile`、`--from-file`、`--library-path`、`--rawfile`、`--slurpfile`、`-L`、`-f`
- `sort`：`--compress-program`、`--files0-from`、`--output`、`--random-source`、`--temporary-directory`、`-T`、`-o`
- `wc`：`--files0-from`

<!-- SAFE_BIN_DENIED_FLAGS:END -->

安全二進位檔還強制 argv token 在執行時被視為 **字面文字**（不進行檔案匹配與 `$VARS` 展開），因此像 `*` 或 `$HOME/...` 這類模式無法用來偷渡檔案讀取。  
安全二進位檔必須從受信任的二進位目錄解析（系統預設加上可選的 `tools.exec.safeBinTrustedDirs`）。`PATH` 條目永遠不會自動被信任。  
預設受信任的安全二進位目錄刻意維持最小：`/bin`、`/usr/bin`。  
如果您的安全二進位檔執行檔位於套件管理器或使用者路徑（例如 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`/snap/bin`），請明確加入 `tools.exec.safeBinTrustedDirs`。  
允許清單模式下不會自動允許 shell 連結與重定向。

Shell 連結（`&&`、`||`、`;`）僅在每個頂層段落皆符合允許清單（包含安全二進位檔或技能自動允許）時被允許。允許清單模式下仍不支援重定向。  
允許清單解析期間會拒絕命令替換（`$()` / 反引號），包含雙引號內；若需要字面 `$()` 文字，請使用單引號。  
在 macOS 伴隨應用程式批准中，包含 shell 控制或展開語法的原始 shell 文字（`&&`、`||`、`;`、`|`、` ` `, `$`, `<`, `>`, `(`, `)）會被視為允許清單未命中，除非 shell 二進位檔本身已在允許清單中。  
對於 shell 包裝器（`bash|sh|zsh ... -c/-lc`），請求範圍的環境變數覆寫會被限制在一個小型明確允許清單（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）。  
在允許清單模式下的「永遠允許」決策中，已知的調度包裝器（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）會保留內部可執行檔路徑，而非包裝器路徑。Shell 多工器（`busybox`、`toybox`）也會被拆解，用於 shell applets（`sh`、`ash` 等），以保留內部可執行檔而非多工器二進位檔。若包裝器或多工器無法安全拆解，則不會自動保留允許清單條目。

預設安全二進位檔：`jq`、`cut`、`uniq`、`head`、`tail`、`tr`、`wc`。

`grep` 和 `sort` 不在預設清單中。若您選擇啟用，請為其非 stdin 工作流程保留明確的允許清單條目。  
對於安全二進位檔模式下的 `grep`，請使用 `-e`/`--regexp` 提供模式；位置模式會被拒絕，避免檔案操作數被模糊位置參數偷渡。

### 安全二進位檔與允許清單的比較

| 主題     | `tools.exec.safeBins`                     | 允許清單 (`exec-approvals.json`)      |
| -------- | ----------------------------------------- | ------------------------------------- |
| 目標     | 自動允許狹義的 stdin 過濾器               | 明確信任特定可執行檔                  |
| 匹配類型 | 可執行檔名稱 + 安全二進位 argv 政策       | 解析後的可執行檔路徑通配符            |
| 參數範圍 | 受安全二進位檔設定檔和字面 token 規則限制 | 僅路徑匹配；參數由您自行負責          |
| 典型範例 | `jq`、`head`、`tail`、`wc`                | `python3`、`node`、`ffmpeg`、自訂 CLI |
| 最佳用途 | 低風險的文字轉換管線                      | 任何具有較廣泛行為或副作用的工具      |

設定位置：

- `safeBins` 來自設定（`tools.exec.safeBins` 或每代理 `agents.list[].tools.exec.safeBins`）。
- `safeBinTrustedDirs` 來自設定（`tools.exec.safeBinTrustedDirs` 或每代理 `agents.list[].tools.exec.safeBinTrustedDirs`）。
- `safeBinProfiles` 來自設定（`tools.exec.safeBinProfiles` 或每代理 `agents.list[].tools.exec.safeBinProfiles`）。每代理設定檔鍵會覆蓋全域鍵。
- 允許清單條目存放於主機本地 `~/.openclaw/exec-approvals.json` 下的 `agents.<id>.allowlist`（或透過控制介面 / `openclaw approvals allowlist ...`）。
- `openclaw security audit` 會在解譯器/執行環境二進位檔出現在 `safeBins` 中卻無明確設定檔時，以 `tools.exec.safe_bins_interpreter_unprofiled` 發出警告。
- `openclaw doctor --fix` 可用於搭建缺失的自訂 `safeBinProfiles.<bin>` 條目作為 `{}`（事後請審查並加強）。解譯器/執行環境二進位檔不會自動搭建。

自訂設定範例：

```json5
{
  tools: {
    exec: {
      safeBins: ["jq", "myfilter"],
      safeBinProfiles: {
        myfilter: {
          minPositional: 0,
          maxPositional: 0,
          allowedValueFlags: ["-n", "--limit"],
          deniedFlags: ["-f", "--file", "-c", "--command"],
        },
      },
    },
  },
}
```

## 控制介面編輯

使用 **Control UI → Nodes → Exec approvals** 卡片來編輯預設值、單一代理覆寫及允許清單。選擇範圍（預設值或某個代理），調整政策，新增/移除允許清單模式，然後按 **儲存**。介面會顯示每個模式的 **最後使用** 元資料，方便你維持清單整潔。

目標選擇器可選擇 **Gateway**（本地批准）或 **Node**。節點必須廣播 `system.execApprovals.get/set`（macOS 應用程式或無頭節點主機）。  
如果節點尚未廣播執行批准，請直接編輯其本地 `~/.openclaw/exec-approvals.json`。

CLI：`openclaw approvals` 支援 gateway 或 node 編輯（詳見 [Approvals CLI](/cli/approvals)）。

## 批准流程

當需要提示時，gateway 會向操作員用戶端廣播 `exec.approval.requested`。Control UI 和 macOS 應用程式透過 `exec.approval.resolve` 解析，然後 gateway 將批准的請求轉發給節點主機。

對於 `host=node`，批准請求包含標準化的 `systemRunPlan` 載荷。gateway 會使用該計畫作為轉發已批准 `system.run` 請求時的權威命令/工作目錄/會話上下文。

## 直譯器／執行時命令

有批准保護的直譯器／執行時執行採取保守策略：

- 精確的 argv/cwd/env 上下文始終被綁定。
- 直接 shell 腳本和直接執行時檔案形式會盡力綁定到一個具體的本地檔案快照。
- 如果 OpenClaw 無法為直譯器／執行時命令精確識別唯一具體本地檔案（例如套件腳本、eval 形式、執行時特定的載入鏈或模糊的多檔案形式），則會拒絕批准保護的執行，而非聲稱擁有其語意涵蓋。
- 對於這些工作流程，建議使用沙箱、獨立主機邊界，或明確的受信任允許清單／完整工作流程，由操作員接受更廣泛的執行時語意。

當需要批准時，exec 工具會立即回傳一個批准 ID。使用該 ID 來關聯後續系統事件 (`Exec finished` / `Exec denied`)。若在逾時前未收到決定，該請求將視為批准逾時，並以拒絕原因呈現。

確認對話框包含：

- 命令與參數
- 工作目錄
- 代理 ID
- 解析後的可執行檔路徑
- 主機與政策元資料

操作選項：

- **允許一次** → 立即執行
- **永久允許** → 加入允許清單並執行
- **拒絕** → 阻擋

## 將核准請求轉發至聊天頻道

您可以將執行核准提示轉發到任何聊天頻道（包含外掛頻道），並使用 `/approve` 進行核准。此功能使用一般的外發傳遞管線。

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

### 內建聊天核准用戶端

Discord 和 Telegram 也可以作為明確的執行核准用戶端，並支援頻道專屬設定。

- Discord: `channels.discord.execApprovals.*`
- Telegram: `channels.telegram.execApprovals.*`

這些用戶端為選擇性啟用。如果頻道未啟用執行核准，OpenClaw 不會僅因對話發生在該頻道就將其視為核准介面。

共通行為：

- 只有設定的核准者可以核准或拒絕
- 請求者不必是核准者
- 啟用頻道傳遞時，核准提示會包含指令文字
- 若無操作介面或設定的核准用戶端能接受請求，提示會回退至 `askFallback`

Telegram 預設將核准提示發送至核准者私訊 (`target: "dm"`)。您可以切換至 `channel` 或 `both`，讓核准提示也出現在原始的 Telegram 聊天或主題中。對於 Telegram 論壇主題，OpenClaw 會保留該主題以供核准提示及核准後的後續追蹤使用。

請參考：

- [Discord](/channels/discord#exec-approvals-in-discord)
- [Telegram](/channels/telegram#exec-approvals-in-telegram)

### macOS IPC 流程

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

安全性說明：

- Unix socket 模式 `0600`，token 儲存在 `exec-approvals.json`。
- 同 UID 的對等端檢查。
- 挑戰/回應機制（nonce + HMAC token + 請求雜湊）+ 短 TTL。

## 系統事件

Exec 生命週期會以系統訊息呈現：

- `Exec running`（僅當指令超過執行時間門檻時）
- `Exec finished`
- `Exec denied`

這些訊息會在節點回報事件後發佈到代理的工作階段中。
Gateway-host exec 批准在指令結束時（以及選擇性地在執行時間超過門檻時）發出相同的生命週期事件。
帶批准限制的 exec 會重用批准 ID 作為這些訊息中的 `runId`，方便關聯。

## 影響

- **full** 權限強大；建議盡可能使用允許清單。
- **ask** 可讓你保持掌握同時仍允許快速批准。
- 每個代理的允許清單可防止一個代理的批准洩漏到其他代理。
- 批准僅適用於來自 **授權發送者** 的 host exec 請求。未授權發送者無法發出 `/exec`。
- `/exec security=full` 是授權操作員的工作階段層級便利功能，設計上會跳過批准。
  若要嚴格阻擋 host exec，請將批准安全性設為 `deny` 或透過工具政策拒絕 `exec` 工具。

相關連結：

- [Exec 工具](/tools/exec)
- [Elevated 模式](/tools/elevated)
- [Skills](/tools/skills)
