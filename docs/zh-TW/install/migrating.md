---
summary: 「將 OpenClaw 的安裝從一台機器移動（遷移）到另一台」
read_when:
  - 「您正在將 OpenClaw 移到新的筆電／伺服器」
  - 「您希望保留工作階段、身分驗證與頻道登入（WhatsApp 等）」
title: 「遷移指南」
x-i18n:
  source_path: install/migrating.md
  source_hash: 604d862c4bf86e79
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:36Z
---

# 將 OpenClaw 遷移到新機器

本指南說明如何在**不重新進行入門引導**的情況下，將 OpenClaw Gateway 閘道器 從一台機器遷移到另一台。

概念上，遷移很簡單：

- 複製 **狀態目錄**（`$OPENCLAW_STATE_DIR`，預設：`~/.openclaw/`）— 其中包含設定、身分驗證、工作階段與頻道狀態。
- 複製您的 **工作區**（預設為 `~/.openclaw/workspace/`）— 其中包含您的代理程式檔案（記憶、提示詞等）。

但在 **設定檔（profiles）**、**權限** 與 **不完整複製** 上，常見一些踩雷點。

## 開始之前（您要遷移的內容）

### 1) 確認您的狀態目錄

多數安裝使用預設值：

- **狀態目錄：** `~/.openclaw/`

但如果您使用下列方式，路徑可能不同：

- `--profile <name>`（通常會變成 `~/.openclaw-<profile>/`）
- `OPENCLAW_STATE_DIR=/some/path`

若不確定，請在 **舊** 機器上執行：

```bash
openclaw status
```

在輸出中尋找提及 `OPENCLAW_STATE_DIR`／profile 的內容。若您執行多個 Gateway 閘道器，請對每個 profile 重複確認。

### 2) 確認您的工作區

常見預設值：

- `~/.openclaw/workspace/`（建議的工作區）
- 您自行建立的自訂資料夾

您的工作區是存放如 `MEMORY.md`、`USER.md` 與 `memory/*.md` 等檔案的位置。

### 3) 了解您將保留哪些內容

若您同時複製 **狀態目錄** 與 **工作區**，將保留：

- Gateway 閘道器 設定（`openclaw.json`）
- 身分驗證設定檔／API 金鑰／OAuth 權杖
- 工作階段歷史與代理程式狀態
- 頻道狀態（例如 WhatsApp 登入／工作階段）
- 您的工作區檔案（記憶、Skills 筆記等）

若您 **只** 複製工作區（例如透過 Git），則 **不會** 保留：

- 工作階段
- 憑證
- 頻道登入

這些內容位於 `$OPENCLAW_STATE_DIR` 之下。

## 遷移步驟（建議）

### 步驟 0 — 建立備份（舊機器）

在 **舊** 機器上，請先停止 Gateway 閘道器，避免在複製過程中檔案變動：

```bash
openclaw gateway stop
```

（選用但建議）將狀態目錄與工作區封存：

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

若您有多個 profile／狀態目錄（例如 `~/.openclaw-main`、`~/.openclaw-work`），請分別封存。

### 步驟 1 — 在新機器上安裝 OpenClaw

在 **新** 機器上，安裝 CLI（以及需要時的 Node）：

- 參見：[Install](/install)

此階段若入門引導建立了新的 `~/.openclaw/` 也沒關係 — 您會在下一步覆蓋它。

### 步驟 2 — 將狀態目錄與工作區複製到新機器

請同時複製 **兩者**：

- `$OPENCLAW_STATE_DIR`（預設為 `~/.openclaw/`）
- 您的工作區（預設為 `~/.openclaw/workspace/`）

常見方式：

- `scp` 這些 tar 封存檔並解壓縮
- 透過 SSH `rsync -a`
- 使用外接硬碟

複製完成後，請確認：

- 已包含隱藏目錄（例如 `.openclaw/`）
- 檔案擁有權正確，屬於執行 Gateway 閘道器 的使用者

### 步驟 3 — 執行 Doctor（遷移＋服務修復）

在 **新** 機器上：

```bash
openclaw doctor
```

Doctor 是「安全且穩定」的指令。它會修復服務、套用設定遷移，並對不一致之處提出警告。

接著執行：

```bash
openclaw gateway restart
openclaw status
```

## 常見踩雷點（以及如何避免）

### 踩雷：profile／狀態目錄不一致

若舊的 Gateway 閘道器 是以某個 profile（或 `OPENCLAW_STATE_DIR`）執行，而新的 Gateway 閘道器 使用了不同的 profile，您可能會看到以下狀況：

- 設定變更未生效
- 頻道遺失／被登出
- 工作階段歷史為空

修正方式：使用**相同**的 profile／狀態目錄來執行您已遷移的 Gateway 閘道器，然後重新執行：

```bash
openclaw doctor
```

### 踩雷：只複製 `openclaw.json`

僅有 `openclaw.json` 並不足夠。許多提供者會將狀態儲存在以下位置：

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

請務必遷移整個 `$OPENCLAW_STATE_DIR` 資料夾。

### 踩雷：權限／擁有權

若您以 root 複製或更換了使用者，Gateway 閘道器 可能無法讀取憑證或工作階段。

修正方式：確認狀態目錄與工作區的擁有者為執行 Gateway 閘道器 的使用者。

### 踩雷：在遠端／本機模式之間遷移

- 若您的 UI（WebUI／TUI）指向 **遠端** Gateway 閘道器，則工作階段儲存與工作區屬於遠端主機。
- 遷移您的筆電並不會移動遠端 Gateway 閘道器 的狀態。

若您處於遠端模式，請遷移 **閘道器主機**。

### 踩雷：備份中的機密資料

`$OPENCLAW_STATE_DIR` 包含機密（API 金鑰、OAuth 權杖、WhatsApp 憑證）。請將備份視同正式環境的機密資料：

- 以加密方式儲存
- 避免透過不安全的通道分享
- 若懷疑外洩，請輪替金鑰

## 驗證檢查清單

在新機器上，請確認：

- `openclaw status` 顯示 Gateway 閘道器 正在執行
- 您的頻道仍保持連線（例如 WhatsApp 不需要重新配對）
- 儀表板可開啟並顯示既有的工作階段
- 您的工作區檔案（記憶、設定）皆存在

## 相關

- [Doctor](/gateway/doctor)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [Where does OpenClaw store its data?](/help/faq#where-does-openclaw-store-its-data)
