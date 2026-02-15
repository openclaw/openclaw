---
title: "專案展示"
description: "來自社群的真實 OpenClaw 專案"
summary: "由 OpenClaw 驅動的社群建置專案與整合"
---

# 專案展示

來自社群的真實專案。看看大家正在使用 OpenClaw 建立什麼。

<Info>
**想要展示您的專案？** 在 Discord 的 [#showcase 頻道分享您的專案](https://discord.gg/clawd) 或 [在 X (前 Twitter) 上標記 @docs-zh-TW/start/openclaw.md](https://x.com/openclaw)。
</Info>

## 🎥 OpenClaw 實際應用

VelvetShark 提供的完整設定教學 (28 分鐘)。

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/SaWSPZoPX34"
    title="OpenClaw: The self-hosted AI that Siri should have been (Full setup)"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[在 YouTube 上觀看](https://www.youtube.com/watch?v=SaWSPZoPX34)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/mMSKQvlmFuQ"
    title="OpenClaw showcase video"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[在 YouTube 上觀看](https://www.youtube.com/watch?v=mMSKQvlmFuQ)

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/5kkIJNUGFho"
    title="OpenClaw community showcase"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[在 YouTube 上觀看](https://www.youtube.com/watch?v=5kkIJNUGFho)

## 🆕 Discord 最新動態

<CardGroup cols={2}>

<Card title="PR 審查 → Telegram 回饋" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  ** @bangnokia** • `review` `github` `telegram`

OpenCode 完成變更 → 開啟 PR → OpenClaw 審查差異並在 Telegram 中回覆「小幅建議」以及明確的合併結論（包括優先處理的關鍵修復）。

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR review feedback delivered in Telegram" />
</Card>

<Card title="數分鐘內建置酒窖 Skills" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  ** @prades_maxime** • `skills` `local` `csv`

向「Robby」（ @docs-zh-TW/start/openclaw.md）請求一個本地酒窖 Skills。它會要求提供一個範例 CSV 匯出檔案 + 儲存位置，然後快速建置/測試該 Skills（範例中有 962 瓶）。

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw building a local wine cellar skill from CSV" />
</Card>

<Card title="Tesco 購物自動駕駛" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  ** @marchattonhere** • `automation` `browser` `shopping`

每週餐點計畫 → 常規訂單 → 預訂送貨時段 → 確認訂單。無需 API，僅需瀏覽器控制。

  <img src="/assets/showcase/tesco-shop.jpg" alt="Tesco shop automation via chat" />
</Card>

<Card title="SNAG 螢幕截圖轉 Markdown" icon="scissors" href="https://github.com/am-will/snag">
  ** @am-will** • `devtools` `screenshots` `markdown`

熱鍵選取螢幕區域 → Gemini 視覺辨識 → 立即將 Markdown 複製到您的剪貼簿。

  <img src="/assets/showcase/snag.png" alt="SNAG screenshot-to-markdown tool" />
</Card>

<Card title="智慧代理 UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  ** @kitze** • `ui` `skills` `sync`

桌面應用程式，用於管理跨智慧代理、Claude、Codex 和 OpenClaw 的 Skills/指令。

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI app" />
</Card>

<Card title="Telegram 語音訊息 (papla.media)" icon="microphone" href="https://papla.media/docs">
  **社群** • `voice` `tts` `telegram`

封裝 papla.media TTS 並將結果作為 Telegram 語音訊息傳送（無惱人的自動播放）。

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram voice note output from TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  ** @odrobnik** • `devtools` `codex` `brew`

透過 Homebrew 安裝的輔助工具，用於列出/檢查/監看本地 OpenAI Codex 工作階段（CLI + VS Code）。

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor on ClawHub" />
</Card>

<Card title="Bambu 3D 印表機控制" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  ** @tobiasbischoff** • `hardware` `3d-printing` `skill`

控制並疑難排解 BambuLab 印表機：狀態、任務、相機、AMS、校準等。

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI skill on ClawHub" />
</Card>

<Card title="維也納交通 (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  ** @hjanuschka** • `travel` `transport` `skill`

維也納大眾運輸的即時班次、中斷、電梯狀態和路線規劃。

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien skill on ClawHub" />
</Card>

<Card title="ParentPay 學校餐點" icon="utensils" href="#">
  ** @George5562** • `automation` `browser` `parenting`

透過 ParentPay 自動預訂英國學校餐點。使用滑鼠座標實現可靠的表格單元格點擊。
</Card>

<Card title="R2 上傳 (傳送我的檔案)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  ** @julianengel** • `files` `r2` `presigned-urls`

上傳至 Cloudflare R2/S3 並產生安全的預簽名下載連結。非常適合遠端 OpenClaw 實例。
</Card>

<Card title="透過 Telegram 建置 iOS 應用程式" icon="mobile" href="#">
  ** @coard** • `ios` `xcode` `testflight`

透過 Telegram 聊天，完整建置一個包含地圖和語音錄製功能的 iOS 應用程式，並部署到 TestFlight。

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS app on TestFlight" />
</Card>

<Card title="Oura Ring 健康助理" icon="heart-pulse" href="#">
  ** @docs-zh-TW/start/showcase.md** • `health` `oura` `calendar`

個人 AI 健康助理，將 Oura ring 資料與日曆、約會和健身房時間表整合。

  <img src="/assets/showcase/oura-health.png" alt="Oura ring health assistant" />
</Card>
<Card title="Kev 的夢幻團隊 (14+ 智慧代理)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  ** @adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

在一個 Gateway 下擁有 14+ 個智慧代理，由 Opus 4.5 編排器委派給 Codex 工作者。詳盡的 [技術文件](https://github.com/adam91holt/orchestrated-ai-articles) 涵蓋夢幻團隊名單、模型選擇、沙箱隔離、webhook、心跳機制和委派流程。[Clawdspace](https://github.com/adam91holt/clawdspace) 用於智慧代理沙箱隔離。[部落格文章](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/)。
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  ** @NessZerra** • `devtools` `linear` `cli` `issues`

適用於 Linear 的 CLI，可與智慧代理工作流程（Claude Code、OpenClaw）整合。從終端機管理問題、專案和工作流程。第一個外部 PR 已合併！
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  ** @jules** • `messaging` `beeper` `cli` `automation`

透過 Beeper Desktop 讀取、傳送和封存訊息。使用 Beeper 本地 MCP API，讓智慧代理可以在一個地方管理您的所有聊天（iMessage、WhatsApp 等）。
</Card>

</CardGroup>

## 🤖 自動化與工作流程

<CardGroup cols={2}>

<Card title="Winix 空氣清淨機控制" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  ** @antonplex** • `automation` `hardware` `air-quality`

Claude Code 發現並確認了清淨機控制，然後 OpenClaw 接管以管理室內空氣品質。

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="Winix air purifier control via OpenClaw" />
</Card>

<Card title="美麗天空相機照片" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  ** @signalgaining** • `automation` `camera` `skill` `images`

由屋頂攝影機觸發：當天空看起來很美時，要求 OpenClaw 拍攝天空照片 — 它設計了一個 Skills 並拍下了照片。

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="Roof camera sky snapshot captured by OpenClaw" />
</Card>

<Card title="視覺化早晨簡報場景" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  ** @buddyhadry** • `automation` `briefing` `images` `telegram`

一個排程提示每天早上透過 OpenClaw 角色產生一個「場景」圖片（天氣、任務、日期、最喜歡的貼文/引言）。
</Card>

<Card title="板式網球場預訂" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  ** @joshp123** • `automation` `booking` `cli`
  
  Playtomic 可用性檢查器 + 預訂 CLI。再也不會錯過空閒球場。
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli screenshot" />
</Card>

<Card title="會計憑證接收" icon="file-invoice-dollar">
  **社群** • `automation` `email` `pdf`
  
  從電子郵件收集 PDF，準備文件給稅務顧問。每月會計自動化。
</Card>

<Card title="沙發馬鈴薯開發模式" icon="couch" href="https://davekiss.com">
  ** @davekiss** • `telegram` `website` `migration` `astro`

在看 Netflix 時透過 Telegram 重建了整個個人網站 — Notion → Astro，遷移了 18 篇文章，DNS 到 Cloudflare。從未打開筆記型電腦。
</Card>

<Card title="職位搜尋智慧代理" icon="briefcase">
  ** @attol8** • `automation` `api` `skill`

搜尋職位列表，與履歷關鍵字匹配，並回傳相關的機會與連結。使用 JSearch API 在 30 分鐘內建置完成。
</Card>

<Card title="Jira Skills 建置器" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  ** @jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw 連接到 Jira，然後即時產生了一個新的 Skills（在 ClawHub 上存在之前）。
</Card>

<Card title="透過 Telegram 的 Todoist Skills" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  ** @iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

自動化 Todoist 任務，並讓 OpenClaw 直接在 Telegram 聊天中產生 Skills。
</Card>

<Card title="TradingView 分析" icon="chart-line">
  ** @bheem1798** • `finance` `browser` `automation`

透過瀏覽器自動化登入 TradingView，截圖圖表，並按需執行技術分析。無需 API — 僅需瀏覽器控制。
</Card>

<Card title="Slack 自動支援" icon="slack">
  ** @henrymascot** • `slack` `automation` `support`

監看公司 Slack 頻道，提供協助回應，並將通知轉發到 Telegram。在未被要求的情況下自主修復了已部署應用程式中的生產錯誤。
</Card>

</CardGroup>

## 🧠 知識與記憶體

<CardGroup cols={2}>

<Card title="xuezh 中文學習" icon="language" href="https://github.com/joshp123/xuezh">
  ** @joshp123** • `learning` `voice` `skill`
  
  中文學習引擎，透過 OpenClaw 提供發音回饋和學習流程。
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh pronunciation feedback" />
</Card>

<Card title="WhatsApp 記憶體保險庫" icon="vault">
  **社群** • `memory` `transcription` `indexing`
  
  擷取完整的 WhatsApp 匯出內容，轉錄 1,000 多條語音訊息，與 git 日誌交叉檢查，輸出連結的 markdown 報告。
</Card>

<Card title="Karakeep 語義搜尋" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  ** @jamesbrooksco** • `search` `vector` `bookmarks`
  
  使用 Qdrant + OpenAI/Ollama 嵌入為 Karakeep 書籤增加向量搜尋功能。
</Card>

<Card title="腦筋急轉彎 2 記憶體" icon="brain">
  **社群** • `memory` `beliefs` `self-model`
  
  獨立的記憶體管理器，將工作階段檔案轉換為記憶體 → 信念 → 不斷演進的自我模型。
</Card>

</CardGroup>

## 🎙️ 語音與電話

<CardGroup cols={2}>

<Card title="Clawdia 電話橋接" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  ** @alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi 語音助理 ↔ OpenClaw HTTP 橋接。與您的智慧代理進行近乎即時的通話。
</Card>

<Card title="OpenRouter 轉錄" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  ** @obviyus** • `transcription` `multilingual` `skill`

透過 OpenRouter (Gemini 等) 進行多語言音訊轉錄。可在 ClawHub 上使用。
</Card>

</CardGroup>

## 🏗️ 基礎設施與部署

<CardGroup cols={2}>

<Card title="Home Assistant 附加元件" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  ** @ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  OpenClaw Gateway 運行於 Home Assistant 作業系統，支援 SSH 通道和持久狀態。
</Card>

<Card title="Home Assistant Skills" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  透過自然語言控制和自動化 Home Assistant 裝置。
</Card>

<Card title="Nix 套件" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  ** @docs-zh-TW/start/openclaw.md** • `nix` `packaging` `deployment`
  
  隨附電池的 nixified OpenClaw 設定，用於可重現的部署。
</Card>

<Card title="CalDAV 日曆" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  使用 khal/vdirsyncer 的日曆 Skills。自託管日曆整合。
</Card>

</CardGroup>

## 🏠 家庭與硬體

<CardGroup cols={2}>

<Card title="GoHome 自動化" icon="house-signal" href="https://github.com/joshp123/gohome">
  ** @joshp123** • `home` `nix` `grafana`
  
  Nix 原生家庭自動化，以 OpenClaw 作為介面，加上精美的 Grafana 儀表板。
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana dashboard" />
</Card>

<Card title="Roborock 吸塵器" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  ** @joshp123** • `vacuum` `iot` `plugin`
  
  透過自然對話控制您的 Roborock 機器人吸塵器。
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock status" />
</Card>

</CardGroup>

## 🌟 社群專案

<CardGroup cols={2}>

<Card title="StarSwap 市場" icon="star" href="https://star-swap.com/">
  **社群** • `marketplace` `astronomy` `webapp`
  
  完整的天文裝備市場。圍繞 OpenClaw 生態系統建置。
</Card>

</CardGroup>

---

## 提交您的專案

有什麼想分享的嗎？我們很樂意展示它！

<Steps>
  <Step title="分享">
    在 Discord 的 [#showcase 頻道發文](https://discord.gg/clawd) 或 [在 X (前 Twitter) 上發推文 @docs-zh-TW/start/openclaw.md](https://x.com/openclaw)
  </Step>
  <Step title="包含詳細資訊">
    告訴我們它的功能、連結到儲存庫/演示、如果有螢幕截圖請分享
  </Step>
  <Step title="獲得展示機會">
    我們會將傑出專案新增到此頁面
  </Step>
</Steps>
