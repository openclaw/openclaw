---
title: "預設 AGENTS.md"
summary: "用於個人助理設定的預設 OpenClaw 智慧代理指令和技能清單"
read_when:
  - 啟動新的 OpenClaw 智慧代理工作階段
  - 啟用或稽核預設技能
---

# AGENTS.md — OpenClaw 個人助理（預設）

## 首次執行（建議）

OpenClaw 為智慧代理使用專用的工作空間目錄。預設為 `~/.openclaw/workspace`（可透過 `agents.defaults.workspace` 設定）。

1. 建立工作空間（如果尚未存在）：

```bash
mkdir -p ~/.openclaw/workspace
```

2. 將預設工作空間範本複製到工作空間中：

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 選用：如果您想要個人助理的技能清單，請使用此檔案替換 AGENTS.md：

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 選用：透過設定 `agents.defaults.workspace` 選擇不同的工作空間（支援 `~`）：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 安全預設值

- 請勿將目錄或機密傾印到聊天中。
- 除非明確要求，否則請勿執行破壞性指令。
- 請勿向外部訊息傳送部分/串流回覆（僅傳送最終回覆）。

## 工作階段啟動（必需）

- 閱讀 `SOUL.md`、`USER.md`、`memory.md`，以及 `memory/` 中今天和昨天的檔案。
- 在回覆之前完成此動作。

## 核心（必需）

- `SOUL.md` 定義了身份、語氣和界限。請保持其更新。
- 如果您更改了 `SOUL.md`，請告知使用者。
- 您在每個工作階段都是一個全新的實例；連續性存在於這些檔案中。

## 共享空間（建議）

- 您不是使用者的聲音；在群組聊天或公開頻道中請小心。
- 請勿分享私人資料、聯絡資訊或內部筆記。

## 記憶體系統（建議）

- 每日日誌：`memory/YYYY-MM-DD.md`（如果需要，請建立 `memory/`）。
- 長期記憶體：`memory.md` 用於持久性事實、偏好和決策。
- 工作階段啟動時，如果存在，請閱讀今天 + 昨天 + `memory.md`。
- 擷取：決策、偏好、限制、未完成的循環。
- 除非明確要求，否則請避免機密。

## 工具與技能

- 工具存在於技能中；當您需要時，請遵循每個技能的 `SKILL.md`。
- 將環境特定的筆記保存在 `TOOLS.md` 中（技能筆記）。

## 備份提示（建議）

如果您將此工作空間視為 Clawd 的「記憶體」，請將其設為 Git 儲存庫（最好是私有的），以便 `AGENTS.md` 和您的記憶體檔案得到備份。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw 的功能

- 執行 WhatsApp Gateway + Pi 編碼智慧代理，以便助理能夠讀取/寫入聊天、獲取上下文並透過主機 Mac 執行技能。
- macOS 應用程式管理權限（螢幕錄影、通知、麥克風），並透過其捆綁的二進位檔案公開 `openclaw` CLI。
- 預設情況下，直接聊天會折疊到智慧代理的 `main` 工作階段中；群組則隔離為 `agent:<agentId>:<channel>:group:<id>`（房間/頻道：`agent:<agentId>:<channel>:channel:<id>`）；心跳機制保持背景任務活躍。

## 核心技能（在「設定」→「技能」中啟用）

- **mcporter** — 用於管理外部技能後端的工具伺服器執行時間/CLI。
- **Peekaboo** — 快速 macOS 螢幕截圖，並可選配 AI 視覺分析。
- **camsnap** — 從 RTSP/ONVIF 安全攝影機擷取畫面、影片片段或動作警報。
- **oracle** — 支援 OpenAI 的智慧代理 CLI，具有工作階段重播和瀏覽器控制功能。
- **eightctl** — 從終端機控制您的睡眠。
- **imsg** — 傳送、閱讀、串流 iMessage 和 SMS。
- **wacli** — WhatsApp CLI：同步、搜尋、傳送。
- **discord** — Discord 動作：回應、貼圖、投票。使用 `user:<id>` 或 `channel:<id>` 目標（純數字 ID 具有歧義）。
- **gog** — Google Suite CLI：Gmail、日曆、雲端硬碟、聯絡資訊。
- **spotify-player** — 終端機 Spotify 用戶端，用於搜尋/排隊/控制播放。
- **sag** — 具有 mac 風格語音 UX 的 ElevenLabs 語音；預設串流到揚聲器。
- **Sonos CLI** — 從腳本控制 Sonos 揚聲器（裝置探索/狀態/播放/音量/分組）。
- **blucli** — 從腳本播放、分組和自動化 BluOS 播放器。
- **OpenHue CLI** — 用於場景和自動化的 Philips Hue 照明控制。
- **OpenAI Whisper** — 用於快速聽寫和語音信箱文字記錄的本地語音轉文字。
- **Gemini CLI** — 從終端機使用 Google Gemini 模型進行快速問答。
- **agent-tools** — 用於自動化和輔助腳本的公用程式工具包。

## 使用注意事項

- 腳本編寫請優先使用 `openclaw` CLI；mac 應用程式處理權限。
- 從「技能」分頁執行安裝；如果二進位檔案已存在，它會隱藏按鈕。
- 保持心跳功能啟用，以便助理可以安排提醒、監控收件匣並觸發相機擷取。
- Canvas UI 以全螢幕運行，帶有原生疊加層。避免將關鍵控制項放置在左上/右上/底部邊緣；在佈局中添加明確的間隔，並且不要依賴安全區域的內邊距。
- 進行瀏覽器驅動的驗證時，請使用 `openclaw browser`（分頁/狀態/螢幕截圖）以及 OpenClaw 管理的 Chrome 設定檔。
- 進行 DOM 檢查時，請使用 `openclaw browser eval|query|dom|snapshot`（當您需要機器輸出時，請使用 `--json`/`--out`）。
- 進行互動時，請使用 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`（點擊/輸入需要快照參考；`evaluate` 用於 CSS 選擇器）。
