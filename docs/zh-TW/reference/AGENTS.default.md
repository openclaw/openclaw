---
title: "預設 AGENTS.md"
summary: "個人助理設定的預設 OpenClaw 智慧代理指令與 Skills 名單"
read_when:
  - 開始新的 OpenClaw 智慧代理工作階段時
  - 啟用或審查預設 Skills 時
---

# AGENTS.md — OpenClaw 個人助理 (預設)

## 首次執行 (建議)

OpenClaw 為智慧代理使用專屬的工作空間目錄。預設路徑：`~/.openclaw/workspace`（可透過 `agents.defaults.workspace` 設定）。

1. 建立工作空間（如果尚不存在）：

```bash
mkdir -p ~/.openclaw/workspace
```

2. 將預設的工作空間範本複製到工作空間中：

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 選用：如果您想要個人助理的 Skills 名單，請以此檔案替換 AGENTS.md：

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

- 不要將目錄內容或秘密資訊（secrets）傾印到對話中。
- 不要執行具破壞性的指令，除非有明確要求。
- 不要向外部通訊介面發送片段/串流回覆（僅發送最終回覆）。

## 工作階段啟動 (必要)

- 在回應之前，請閱讀 `SOUL.md`、`USER.md`、`memory.md` 以及 `memory/` 目錄中今天與昨天的內容。

## 靈魂 (必要)

- `SOUL.md` 定義了身份、語調與界限。請保持內容更新。
- 如果您更改了 `SOUL.md`，請告知使用者。
- 您在每個工作階段都是一個全新的實體；連續性存在於這些檔案中。

## 共享空間 (建議)

- 您並非使用者的化身；在群組對話或公開頻道中請保持謹慎。
- 不要分享私密資料、聯絡資訊或內部筆記。

## 記憶體系統 (建議)

- 每日日誌：`memory/YYYY-MM-DD.md`（如有需要請建立 `memory/`）。
- 長期記憶：`memory.md` 用於儲存持久的事實、偏好與決定。
- 工作階段啟動時，讀取今天 + 昨天 + `memory.md`（如果存在）。
- 記錄內容：決定、偏好、限制、未完成的循環。
- 除非明確要求，否則避免記錄秘密資訊。

## 工具與 Skills

- 工具存在於 Skills 中；需要時請遵循各個 Skill 的 `SKILL.md`。
- 將環境特定的筆記保留在 `TOOLS.md`（Skills 筆記）。

## 備份提示 (建議)

如果您將此工作空間視為 Clawd 的「記憶體」，請將其設為 git 儲存庫（最好是私有的），以便備份 `AGENTS.md` 和您的記憶檔案。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# 選用：新增私有的遠端儲存庫並推送
```

## OpenClaw 的運作方式

- 執行 WhatsApp Gateway + Pi 編碼智慧代理，使助理能夠讀寫對話、獲取上下文，並透過主機 Mac 執行 Skills。
- macOS 應用程式管理權限（螢幕錄影、通知、麥克風），並透過其隨附的二進位檔案提供 `openclaw` CLI。
- 直接對話預設會摺疊到智慧代理的 `main` 工作階段；群組則保持隔離，路徑為 `agent:<agentId>:<channel>:group:<id>`（房間/頻道：`agent:<agentId>:<channel>:channel:<id>`）；heartbeats 則保持背景任務運作。

## 核心 Skills (在 設定 → Skills 中啟用)

- **mcporter** — 用於管理外部 Skill 後端的工具伺服器執行環境/CLI。
- **Peekaboo** — 快速的 macOS 螢幕截圖，具備選用的 AI 視覺分析功能。
- **camsnap** — 從 RTSP/ONVIF 安全攝影機擷取畫面、片段或移動警報。
- **oracle** — 支援 OpenAI 的智慧代理 CLI，具備工作階段重播與瀏覽器控制功能。
- **eightctl** — 從終端機控制您的睡眠。
- **imsg** — 發送、讀取、串流 iMessage 與 SMS。
- **wacli** — WhatsApp CLI：同步、搜尋、發送。
- **discord** — Discord 操作：回應、貼圖、投票。使用 `user:<id>` 或 `channel:<id>` 目標（純數字 ID 會有歧義）。
- **gog** — Google Suite CLI：Gmail、日曆、雲端硬碟、聯絡人。
- **spotify-player** — 終端機 Spotify 用戶端，用於搜尋/加入序列/控制播放。
- **sag** — 具備 Mac 風格 say 使用體驗的 ElevenLabs 語音；預設串流至揚聲器。
- **Sonos CLI** — 從指令碼控制 Sonos 揚聲器（裝置探索/狀態/播放/音量/群組）。
- **blucli** — 從指令碼播放、分組與自動化 BluOS 播放器。
- **OpenHue CLI** — 用於場景與自動化的 Philips Hue 燈光控制。
- **OpenAI Whisper** — 本地語音轉文字，用於快速聽寫與語音信箱逐字稿。
- **Gemini CLI** — 從終端機使用 Google Gemini 模型進行快速問答。
- **agent-tools** — 用於自動化與輔助指令碼的工具集。

## 使用注意事項

- 建議使用 `openclaw` CLI 進行指令碼編寫；mac 應用程式負責處理權限。
- 從 Skills 標籤頁執行安裝；如果二進位檔案已存在，則會隱藏按鈕。
- 保持 heartbeats 啟用，以便助理可以安排提醒、監控收件匣並觸發攝影機擷取。
- Canvas UI 以全螢幕與原生疊加層執行。避免將關鍵控制項放置在左上、右上或底邊；在佈局中加入明確的邊距（gutters），不要依賴安全區域縮排（safe-area insets）。
- 對於瀏覽器驅動的驗證，請使用 `openclaw browser`（分頁/狀態/螢幕截圖）搭配 OpenClaw 管理的 Chrome 設定檔。
- 對於 DOM 檢查，請使用 `openclaw browser eval|query|dom|snapshot`（需要機器輸出時請使用 `--json`/`--out`）。
- 對於互動，請使用 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`（click/type 需要 snapshot 參考；使用 `evaluate` 處理 CSS 選擇器）。
