---
title: Default AGENTS.md
summary: >-
  Default OpenClaw agent instructions and skills roster for the personal
  assistant setup
read_when:
  - Starting a new OpenClaw agent session
  - Enabling or auditing default skills
---

# AGENTS.md — OpenClaw 個人助理（預設）

## 初次執行（建議）

OpenClaw 為代理程式使用專屬的工作目錄。預設為 `~/.openclaw/workspace`（可透過 `agents.defaults.workspace` 設定）。

1. 建立工作目錄（如果尚未存在）：

```bash
mkdir -p ~/.openclaw/workspace
```

2. 將預設的工作目錄範本複製到工作目錄中：

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. 選擇性：如果你想要個人助理的技能清單，請用此檔案取代 AGENTS.md：

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. 選擇性：透過設定 `agents.defaults.workspace`（支援 `~`）來選擇不同的工作目錄：

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## 安全預設

- 不要在聊天中傾印目錄或機密資訊。
- 除非明確要求，否則不要執行破壞性指令。
- 不要將部分或串流回覆發送到外部訊息介面（僅限最終回覆）。

## 啟動會話（必須）

- 讀取 `SOUL.md`、`USER.md`、`memory.md`，以及 `memory/` 中的今天和昨天資料。
- 請在回覆前完成此步驟。

## 核心精神（必填）

- `SOUL.md` 定義身份、語氣與界限，請保持最新。
- 若你更改了 `SOUL.md`，請告知使用者。
- 你每次會話都是全新實例；連續性存在於這些檔案中。

## 共享空間（建議）

- 你不是使用者的聲音；在群組聊天或公開頻道請謹慎。
- 不要分享私人資料、聯絡資訊或內部備註。

## 記憶系統（建議）

- 每日記錄：`memory/YYYY-MM-DD.md`（如有需要，建立 `memory/`）。
- 長期記憶：`memory.md` 用於保存持久事實、偏好與決策。
- 會話開始時，讀取今天、昨天及如有的 `memory.md`。
- 捕捉：決策、偏好、限制條件、未完成事項。
- 除非明確要求，避免保存秘密。

## 工具與技能

- 工具存在於技能中；需要時遵循各技能的 `SKILL.md`。
- 將環境相關備註保存在 `TOOLS.md`（技能備註）。

## 備份建議（建議）

若你將此工作區視為 Clawd 的「記憶」，請將其設為 git 倉庫（最好是私有），以便 `AGENTS.md` 與你的記憶檔案能被備份。

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## OpenClaw 功能

- 執行 WhatsApp 閘道與 Pi 編碼代理，讓助理能讀寫聊天、擷取上下文，並透過主機 Mac 執行技能。
- macOS 應用管理權限（螢幕錄製、通知、麥克風），並透過內建二進位檔暴露 `openclaw` CLI。
- 直接聊天預設合併至代理的 `main` 會話；群組則保持獨立為 `agent:<agentId>:<channel>:group:<id>`（房間/頻道：`agent:<agentId>:<channel>:channel:<id>`）；心跳機制維持背景任務活躍。

## 核心技能（於設定 → 技能中啟用）

- **mcporter** — 管理外部技能後端的工具伺服器執行環境/CLI。
- **Peekaboo** — 快速 macOS 螢幕截圖，附帶可選的 AI 視覺分析。
- **camsnap** — 從 RTSP/ONVIF 監控攝影機擷取影格、片段或動態警示。
- **oracle** — 支援 OpenAI 的代理 CLI，具備會話重播與瀏覽器控制。
- **eightctl** — 從終端機控制你的睡眠。
- **imsg** — 傳送、閱讀、串流 iMessage 與 SMS。
- **wacli** — WhatsApp CLI：同步、搜尋、發送。
- **discord** — Discord 操作：回應、貼圖、投票。使用 `user:<id>` 或 `channel:<id>` 目標（純數字 ID 可能有歧義）。
- **gog** — Google 套件 CLI：Gmail、行事曆、雲端硬碟、聯絡人。
- **spotify-player** — 終端機 Spotify 用戶端，搜尋/排隊/控制播放。
- **sag** — ElevenLabs 語音，搭配 mac 風格 say UX；預設串流至喇叭。
- **Sonos CLI** — 從腳本控制 Sonos 喇叭（發現/狀態/播放/音量/群組）。
- **blucli** — 從腳本播放、群組與自動化 BluOS 播放器。
- **OpenHue CLI** — Philips Hue 燈光控制，支援場景與自動化。
- **OpenAI Whisper** — 本地語音轉文字，用於快速口述與語音信箱轉錄。
- **Gemini CLI** — 終端機使用 Google Gemini 模型，快速問答。
- **agent-tools** — 自動化與輔助腳本的工具包。

## 使用說明

- 建議使用 `openclaw` CLI 進行腳本操作；mac 應用程式會處理權限問題。
- 從 Skills 分頁執行安裝；如果已存在二進位檔，按鈕會自動隱藏。
- 保持心跳功能開啟，讓助理能排程提醒、監控收件匣並觸發相機拍攝。
- Canvas UI 以全螢幕模式執行並帶有原生覆蓋層。避免將重要控制項放在左上/右上/底部邊緣；在版面設定中加入明確的邊距，不要依賴安全區域內距。
- 針對瀏覽器驅動的驗證，使用 `openclaw browser`（分頁/狀態/截圖）搭配 OpenClaw 管理的 Chrome 使用者設定檔。
- 針對 DOM 檢查，使用 `openclaw browser eval|query|dom|snapshot`（需要機器輸出時搭配 `--json`/`--out`）。
- 針對互動操作，使用 `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run`（點擊/輸入需快照參考；CSS 選擇器請用 `evaluate`）。
