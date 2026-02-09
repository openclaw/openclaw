---
summary: "將 OpenClaw 的安裝從一台機器移動（遷移）到另一台"
read_when:
  - 您正在將 OpenClaw 移到新的筆電／伺服器
  - 您希望保留工作階段、身分驗證與頻道登入（WhatsApp 等）
title: "遷移指南"
---

# 將 OpenClaw 遷移到新機器

本指南說明如何在**不重新進行入門引導**的情況下，將 OpenClaw Gateway 閘道器 從一台機器遷移到另一台。

概念上，遷移很簡單：

- 複製 **狀態目錄**（`$OPENCLAW_STATE_DIR`，預設：`~/.openclaw/`）— 其中包含設定、身分驗證、工作階段與頻道狀態。
- 複製您的 **工作區**（預設為 `~/.openclaw/workspace/`）— 其中包含您的代理程式檔案（記憶、提示詞等）。

但在 **設定檔（profiles）**、**權限** 與 **不完整複製** 上，常見一些踩雷點。

## 開始之前（您要遷移的內容）

### 1. 確認您的狀態目錄

多數安裝使用預設值：

- **狀態目錄：** `~/.openclaw/`

但如果您使用下列方式，路徑可能不同：

- `--profile <name>`（通常會變成 `~/.openclaw-<profile>/`）
- `OPENCLAW_STATE_DIR=/some/path`

若不確定，請在 **舊** 機器上執行：

```bash
openclaw status
```

Look for mentions of `OPENCLAW_STATE_DIR` / profile in the output. If you run multiple gateways, repeat for each profile.

### 2. 確認您的工作區

常見預設值：

- `~/.openclaw/workspace/`（建議的工作區）
- 您自行建立的自訂資料夾

您的工作區是存放如 `MEMORY.md`、`USER.md` 與 `memory/*.md` 等檔案的位置。

### 3. 了解您將保留哪些內容

若您同時複製 **狀態目錄** 與 **工作區**，將保留：

- Gateway 閘道器 設定（`openclaw.json`）
- 身分驗證設定檔／API 金鑰／OAuth 權杖
- Session history + agent state
- 頻道狀態（例如 WhatsApp 登入／工作階段）
- 您的工作區檔案（記憶、Skills 筆記等）

若您 **只** 複製工作區（例如透過 Git），則 **不會** 保留：

- cli/sessions.md
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

### Step 2 — Copy the state dir + workspace to the new machine

請同時複製 **兩者**：

- `$OPENCLAW_STATE_DIR`（預設為 `~/.openclaw/`）
- 您的工作區（預設為 `~/.openclaw/workspace/`）

常見方式：

- `scp` the tarballs and extract
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

Doctor 是「安全且穩定」的指令。它會修復服務、套用設定遷移，並對不一致之處提出警告。 It repairs services, applies config migrations, and warns about mismatches.

然後：

```bash
openclaw gateway restart
openclaw status
```

## 常見踩雷點（以及如何避免）

### 踩雷：profile／狀態目錄不一致

若舊的 Gateway 閘道器 是以某個 profile（或 `OPENCLAW_STATE_DIR`）執行，而新的 Gateway 閘道器 使用了不同的 profile，您可能會看到以下狀況：

- 設定變更未生效
- 頻道遺失／被登出
- empty session history

修正方式：使用**相同**的 profile／狀態目錄來執行您已遷移的 Gateway 閘道器，然後重新執行：

```bash
openclaw doctor
```

### 踩雷：只複製 `openclaw.json`

僅有 `openclaw.json` 並不足夠。許多提供者會將狀態儲存在以下位置： Many providers store state under:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

請務必遷移整個 `$OPENCLAW_STATE_DIR` 資料夾。

### 踩雷：權限／擁有權

If you copied as root or changed users, the gateway may fail to read credentials/sessions.

Fix: ensure the state dir + workspace are owned by the user running the gateway.

### 踩雷：在遠端／本機模式之間遷移

- If your UI (WebUI/TUI) points at a **remote** gateway, the remote host owns the session store + workspace.
- 遷移您的筆電並不會移動遠端 Gateway 閘道器 的狀態。

若您處於遠端模式，請遷移 **閘道器主機**。

### 踩雷：備份中的機密資料

`$OPENCLAW_STATE_DIR` 包含機密（API 金鑰、OAuth 權杖、WhatsApp 憑證）。請將備份視同正式環境的機密資料： Treat backups like production secrets:

- 以加密方式儲存
- 避免透過不安全的通道分享
- rotate keys if you suspect exposure

## 驗證檢查清單

在新機器上，請確認：

- `openclaw status` 顯示 Gateway 閘道器 正在執行
- 您的頻道仍保持連線（例如 WhatsApp 不需要重新配對）
- The dashboard opens and shows existing sessions
- 您的工作區檔案（記憶、設定）皆存在

## Related

- [Doctor](/gateway/doctor)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [Where does OpenClaw store its data?](/help/faq#where-does-openclaw-store-its-data)
