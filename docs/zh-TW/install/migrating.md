---
summary: "將 OpenClaw 安裝從一台機器移動（遷移）到另一台機器"
read_when:
  - 您正在將 OpenClaw 遷移到新的筆記型電腦/伺服器
  - 您希望保留工作階段、憑證和頻道登入（WhatsApp 等）
title: "遷移指南"
---

# 將 OpenClaw 遷移到新機器

本指南將 OpenClaw Gateway 從一台機器遷移到另一台，**無需重新進行新手導覽**。

遷移概念上很簡單：

- 複製**狀態目錄** (`$OPENCLAW_STATE_DIR`，預設值：`~/.openclaw/`) — 這包含設定、憑證、工作階段和頻道狀態。
- 複製您的**工作區** (`~/.openclaw/workspace/` 預設) — 這包含您的智慧代理檔案（記憶體、提示等）。

但圍繞著**設定檔**、**權限**和**部分複製**存在常見的陷阱。

## 開始之前（您正在遷移的內容）

### 1) 識別您的狀態目錄

大多數安裝使用預設值：

- **狀態目錄:** `~/.openclaw/`

但如果您使用以下項目，它可能會不同：

- `--profile <name>` (通常會變成 `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

如果您不確定，請在**舊**機器上執行：

```bash
openclaw status
```

在輸出中尋找 `OPENCLAW_STATE_DIR` / profile 的提及。如果您運行多個 Gateway，請為每個設定檔重複此操作。

### 2) 識別您的工作區

常見預設值：

- `~/.openclaw/workspace/` (推薦的工作區)
- 您建立的自訂資料夾

您的工作區是 `MEMORY.md`、`USER.md` 和 `memory/*.md` 等檔案的所在地。

### 3) 了解您將保留的內容

如果您複製**狀態目錄和工作區兩者**，您將保留：

- Gateway 設定 (`openclaw.json`)
- 憑證設定檔 / API 金鑰 / OAuth 憑證
- 工作階段歷史記錄 + 智慧代理狀態
- 頻道狀態（例如 WhatsApp 登入/工作階段）
- 您的工作區檔案（記憶體、Skills 筆記等）

如果您**僅**複製工作區（例如，透過 Git），您將**不**保留：

- 工作階段
- 憑證
- 頻道登入

這些位於 `$OPENCLAW_STATE_DIR` 下。

## 遷移步驟（推薦）

### 步驟 0 — 建立備份（舊機器）

在**舊**機器上，首先停止 Gateway，這樣檔案就不會在複製過程中被修改：

```bash
openclaw gateway stop
```

（可選但推薦）封存狀態目錄和工作區：

```bash
# 如果您使用設定檔或自訂位置，請調整路徑
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

如果您有多個設定檔/狀態目錄（例如 `~/.openclaw-main`、`~/.openclaw-work`），請分別封存。

### 步驟 1 — 在新機器上安裝 OpenClaw

在**新**機器上，安裝 CLI (如果需要，還有 Node)：

- 請參閱：[安裝](/install)

在此階段，如果新手導覽建立了新的 `~/.openclaw/` 則沒關係 — 您將在下一個步驟中覆蓋它。

### 步驟 2 — 將狀態目錄 + 工作區複製到新機器

複製**兩者**：

- `$OPENCLAW_STATE_DIR` (預設 `~/.openclaw/`)
- 您的工作區 (預設 `~/.openclaw/workspace/`)

常見方法：

- `scp` 壓縮檔案並解壓縮
- 透過 SSH `rsync -a`
- 外接硬碟

複製後，請確保：

- 隱藏目錄已包含在內（例如 `.openclaw/`）
- 檔案所有權對於運行 Gateway 的使用者是正確的

### 步驟 3 — 運行 Doctor（遷移 + 服務修復）

在**新**機器上：

```bash
openclaw doctor
```

Doctor 是「安全無聊」的命令。它修復服務、應用設定遷移並警告不匹配項。

然後：

```bash
openclaw gateway restart
openclaw status
```

## 常見陷阱（以及如何避免）

### 陷阱：設定檔 / 狀態目錄不匹配

如果您使用設定檔（或 `OPENCLAW_STATE_DIR`）運行舊 Gateway，而新 Gateway 使用不同的設定檔，您會看到以下症狀：

- 設定更改未生效
- 頻道遺失 / 登出
- 空的工作階段歷史記錄

修復：使用您遷移的**相同**設定檔/狀態目錄運行 Gateway/服務，然後重新運行：

```bash
openclaw doctor
```

### 陷阱：僅複製 `openclaw.json`

`openclaw.json` 是不夠的。許多供應商在以下位置儲存狀態：

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

始終遷移整個 `$OPENCLAW_STATE_DIR` 資料夾。

### 陷阱：權限 / 所有權

如果您以 root 身分複製或更改了使用者，Gateway 可能無法讀取憑證/工作階段。

修復：確保狀態目錄 + 工作區歸運行 Gateway 的使用者所有。

### 陷阱：在遠端/本地模式之間遷移

- 如果您的 UI (WebUI/TUI) 指向**遠端** Gateway，則遠端主機擁有工作階段儲存 + 工作區。
- 遷移您的筆記型電腦不會移動遠端 Gateway 的狀態。

如果您處於遠端模式，請遷移**Gateway 主機**。

### 陷阱：備份中的秘密資訊

`$OPENCLAW_STATE_DIR` 包含秘密資訊（API 金鑰、OAuth 憑證、WhatsApp 憑證）。像對待生產環境秘密資訊一樣對待備份：

- 儲存加密
- 避免透過不安全的頻道分享
- 如果您懷疑洩露，請輪換金鑰

## 驗證清單

在新機器上，確認：

- `openclaw status` 顯示 Gateway 正在運行
- 您的頻道仍然連接（例如 WhatsApp 不需要重新配對）
- 儀表板打開並顯示現有的工作階段
- 您的工作區檔案（記憶體、設定）存在

## 相關

- [Doctor](/gateway/doctor)
- [Gateway 疑難排解](/gateway/troubleshooting)
- [OpenClaw 將其資料儲存在何處？](/help/faq#where-does-openclaw-store-its-data)
