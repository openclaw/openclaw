---
summary: "將 OpenClaw 安裝從一台機器移動（遷移）到另一台機器"
read_when:
  - 您正在將 OpenClaw 移動到新的筆記型電腦/伺服器
  - 您希望保留工作階段、憑證和頻道登入資訊（WhatsApp 等）
title: "遷移指南"
---

# 將 OpenClaw 遷移到新機器

本指南介紹如何將 OpenClaw Gateway 從一台機器遷移到另一台機器，且**無需重新進行新手導覽**。

遷移的概念在邏輯上很簡單：

- 複製 **狀態目錄** (`$OPENCLAW_STATE_DIR`，預設：`~/.openclaw/`) —— 這包含設定、憑證、工作階段和頻道狀態。
- 複製您的 **工作區** (預設為 `~/.openclaw/workspace/`) —— 這包含您的智慧代理檔案（記憶體、提示詞等）。

但在 **設定檔 (profiles)**、**權限** 和 **部分複製** 方面，有一些常見的陷阱需要注意。

## 開始之前（您要遷移的內容）

### 1) 識別您的狀態目錄

大多數安裝使用預設值：

- **狀態目錄：** `~/.openclaw/`

但如果您使用以下項目，路徑可能會有所不同：

- `--profile <name>` (通常會變成 `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

如果您不確定，請在**舊**機器上執行：

```bash
openclaw status
```

在輸出中尋找提到的 `OPENCLAW_STATE_DIR` / profile。如果您執行多個 Gateway，請對每個 profile 重複此操作。

### 2) 識別您的工作區

常見的預設值：

- `~/.openclaw/workspace/` (建議的工作區)
- 您建立的自定義資料夾

您的工作區是存放 `MEMORY.md`、`USER.md` 和 `memory/*.md` 等檔案的地方。

### 3) 瞭解將保留的內容

如果您複製了狀態目錄和工作區**兩者**，您將保留：

- Gateway 設定 (`openclaw.json`)
- 憑證設定檔 / API 金鑰 / OAuth 權杖
- 工作階段歷史記錄 + 智慧代理狀態
- 頻道狀態 (例如 WhatsApp 登入/工作階段)
- 您的工作區檔案 (記憶體、Skills 筆記等)

如果您**只**複製工作區 (例如透過 Git)，則**不會**保留：

- 工作階段
- 認證資訊
- 頻道登入

這些內容儲存在 `$OPENCLAW_STATE_DIR` 下。

## 遷移步驟（建議）

### 步驟 0 — 建立備份（舊機器）

在**舊**機器上，先停止 Gateway 以確保檔案在複製過程中不會變動：

```bash
openclaw gateway stop
```

(選用但建議) 將狀態目錄和工作區存檔：

```bash
# 如果您使用 profile 或自定義位置，請調整路徑
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

如果您有多個 profile/狀態目錄 (例如 `~/.openclaw-main`, `~/.openclaw-work`)，請分別存檔。

### 步驟 1 — 在新機器上安裝 OpenClaw

在**新**機器上，安裝 CLI (如果需要，也安裝 Node)：

- 請參閱：[安裝](/install)

在此階段，即使新手導覽建立了一個新的 `~/.openclaw/` 也沒關係 —— 您將在下一步中覆蓋它。

### 步驟 2 — 將狀態目錄 + 工作區複製到新機器

複製**兩者**：

- `$OPENCLAW_STATE_DIR` (預設 `~/.openclaw/`)
- 您的工作區 (預設 `~/.openclaw/workspace/`)

常見的方法：

- 透過 `scp` 傳輸壓縮檔並解壓縮
- 透過 SSH 使用 `rsync -a`
- 使用外部硬碟

複製後，請確保：

- 包含隱藏目錄 (例如 `.openclaw/`)
- 檔案擁有者對於執行 Gateway 的使用者是正確的

### 步驟 3 — 執行 Doctor（遷移 + 服務修復）

在**新**機器上：

```bash
openclaw doctor
```

Doctor 是一個「安全且平淡」的指令。它會修復服務、套用設定遷移，並針對不匹配的情況發出警告。

接著：

```bash
openclaw gateway restart
openclaw status
```

## 常見的陷阱（以及如何避免）

### 陷阱：profile / 狀態目錄不匹配

如果您在舊的 Gateway 使用 profile (或 `OPENCLAW_STATE_DIR`) 執行，而新的 Gateway 使用不同的設定，您會看到如下症狀：

- 設定更改未生效
- 頻道遺失 / 已登出
- 工作階段歷史記錄為空

修正方法：使用與遷移時**相同**的 profile/狀態目錄執行 Gateway/服務，然後重新執行：

```bash
openclaw doctor
```

### 陷阱：僅複製 `openclaw.json`

僅複製 `openclaw.json` 是不夠的。許多供應商將狀態儲存在：

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

請務必遷移整個 `$OPENCLAW_STATE_DIR` 資料夾。

### 陷阱：權限 / 擁有者

如果您以 root 身分複製或更改了使用者，Gateway 可能無法讀取憑證/工作階段。

修正方法：確保狀態目錄 + 工作區的擁有者是執行 Gateway 的使用者。

### 陷阱：在遠端/本地模式之間遷移

- 如果您的 UI (WebUI/TUI) 指向**遠端** Gateway，則遠端主機擁有工作階段儲存空間 + 工作區。
- 遷移您的筆記型電腦並不會移動遠端 Gateway 的狀態。

如果您處於遠端模式，請遷移 **Gateway 主機**。

### 陷阱：備份中的秘密 (Secrets)

`$OPENCLAW_STATE_DIR` 包含秘密資訊 (API 金鑰、OAuth 權杖、WhatsApp 憑證)。請像處理正式環境秘密一樣處理備份：

- 加密儲存
- 避免透過不安全的管道分享
- 如果懷疑外洩，請輪換金鑰

## 驗證清單

在新機器上確認：

- `openclaw status` 顯示 Gateway 正在執行
- 您的頻道仍保持連線 (例如 WhatsApp 不需要重新配對)
- Dashboard 可以開啟並顯示現有的工作階段
- 您的工作區檔案 (記憶體、設定) 都存在

## 相關內容

- [Doctor](/gateway/doctor)
- [Gateway 疑難排解](/gateway/troubleshooting)
- [OpenClaw 將資料儲存在哪裡？](/help/faq#where-does-openclaw-store-its-data)
