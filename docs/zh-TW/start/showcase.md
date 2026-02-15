---
title: "案例展示"
description: "來自社群的真實 OpenClaw 專案"
summary: "由 OpenClaw 驅動的社群構建專案與整合"
---

# 案例展示

來自社群的真實專案。看看大家正在用 OpenClaw 打造什麼。

<Info>
**想要展示你的作品嗎？** 在 [Discord 的 #showcase 頻道](https://discord.gg/clawd) 分享你的專案，或 [在 X 上標記 @start/openclaw.md](https://x.com/openclaw)。
</Info>

## 🎥 OpenClaw 實際運作

VelvetShark 製作的完整設定導覽 (28m)。

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

## 🆕 來自 Discord 的最新動態

<CardGroup cols={2}>

<Card title="PR 審查 → Telegram 回饋" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  ** @bangnokia** • `review` `github` `telegram`

OpenCode 完成變更 → 開啟 PR → OpenClaw 審查 diff 並在 Telegram 回覆「微小建議」以及明確的合併判定（包含優先套用的關鍵修復）。

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="在 Telegram 中傳送的 OpenClaw PR 審查回饋" />
</Card>

<Card title="幾分鐘內完成酒窖 Skills" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  ** @prades_maxime** • `skills` `local` `csv`

向「Robby」 ( @start/openclaw.md) 要求一個本機酒窖 Skills。它要求提供 CSV 匯出範例 + 儲存位置，接著快速構建並測試該 Skills（範例中有 962 瓶酒）。

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw 正在根據 CSV 構建本機酒窖 Skills" />
</Card>

<Card title="Tesco 購物自動駕駛" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  ** @marchattonhere** • `automation` `browser` `shopping`

每週飲食計畫 → 常購商品 → 預約配送時段 → 確認訂單。無須 API，僅透過瀏覽器控制。

  <img src="/assets/showcase/tesco-shop.jpg" alt="透過聊天進行的 Tesco 購物自動化" />
</Card>

<Card title="SNAG 螢幕截圖轉 Markdown" icon="scissors" href="https://github.com/am-will/snag">
  ** @am-will** • `devtools` `screenshots` `markdown`

熱鍵選取螢幕區域 → Gemini 視覺辨識 → 剪貼簿立即獲得 Markdown。

  <img src="/assets/showcase/snag.png" alt="SNAG 螢幕截圖轉 Markdown 工具" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  ** @kitze** • `ui` `skills` `sync`

用於管理跨 Agents、Claude、Codex 與 OpenClaw 的 Skills/指令的桌面應用程式。

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI 應用程式" />
</Card>

<Card title="Telegram 語音訊息 (papla.media)" icon="microphone" href="https://papla.media/docs">
  **社群** • `voice` `tts` `telegram`

封裝 papla.media TTS 並將結果作為 Telegram 語音訊息傳送（沒有惱人的自動播放）。

  <img src="/assets/showcase/papla-tts.jpg" alt="來自 TTS 的 Telegram 語音訊息輸出" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.com/odrobnik/codexmonitor">
  ** @odrobnik** • `devtools` `codex` `brew`

透過 Homebrew 安裝的輔助工具，用於列出/檢查/監看本機 OpenAI Codex 工作階段 (CLI + VS Code)。

  <img src="/assets/showcase/codexmonitor.png" alt="ClawHub 上的 CodexMonitor" />
</Card>

<Card title="Bambu 3D 印表機控制" icon="print" href="https://clawhub.com/tobiasbischoff/bambu-cli">
  ** @tobiasbischoff** • `hardware` `3d-printing` `skill`

控制並對 BambuLab 印表機進行疑難排解：狀態、工作、攝影機、AMS、校準等。

  <img src="/assets/showcase/bambu-cli.png" alt="ClawHub 上的 Bambu CLI Skill" />
</Card>

<Card title="維也納交通 (Wiener Linien)" icon="train" href="https://clawhub.com/hjanuschka/wienerlinien">
  ** @hjanuschka** • `travel` `transport` `skill`

維也納大眾運輸的即時發車時間、故障資訊、電梯狀態與路線規劃。

  <img src="/assets/showcase/wienerlinien.png" alt="ClawHub 上的 Wiener Linien Skill" />
</Card>

<Card title="ParentPay 學校午餐" icon="utensils" href="#">
  ** @George5562** • `automation` `browser` `parenting`

透過 ParentPay 自動化預訂英國學校午餐。使用滑鼠座標確保表格單元格點擊的可靠性。
</Card>

<Card title="R2 上傳 (傳送我的檔案)" icon="cloud-arrow-up" href="https://clawhub.com/skills/r2-upload">
  ** @julianengel** • `files` `r2` `presigned-urls`

上傳至 Cloudflare R2/S3 並產生安全的預簽名下載連結。非常適合遠端 OpenClaw 實例。
</Card>

<Card title="透過 Telegram 製作 iOS App" icon="mobile" href="#">
  ** @coard** • `ios` `xcode` `testflight`

構建了一個包含地圖與語音錄製的完整 iOS App，並完全透過 Telegram 聊天部署至 TestFlight。

  <img src="/assets/showcase/ios-testflight.jpg" alt="TestFlight 上的 iOS App" />
</Card>

<Card title="Oura Ring 健康助手" icon="heart-pulse" href="#">
  ** @start/showcase.md • `health` `oura` `calendar`

個人 AI 健康助手，整合 Oura Ring 數據與行事曆、預約以及健身房行程。

  <img src="/assets/showcase/oura-health.png" alt="Oura Ring 健康助手" />
</Card>
<Card title="Kev 的夢幻團隊 (14+ 智慧代理)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  ** @adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

在一個 Gateway 下運行 14+ 個智慧代理，由 Opus 4.5 編排器委派工作給 Codex 執行者。詳盡的 [技術報告](https://github.com/adam91holt/orchestrated-ai-articles) 涵蓋了夢幻團隊成員、模型選擇、沙箱隔離、Webhook、心跳檢查以及委派流程。使用 [Clawdspace](https://github.com/adam91holt/clawdspace) 進行智慧代理沙箱隔離。參考 [部落格文章](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/)。
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  ** @NessZerra** • `devtools` `linear` `cli` `issues`

與智慧代理工作流 (Claude Code, OpenClaw) 整合的 Linear CLI。從終端機管理議題 (issues)、專案與工作流。第一個外部 PR 已合併！
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  ** @jules** • `messaging` `beeper` `cli` `automation`

透過 Beeper Desktop 讀取、傳送與封存訊息。使用 Beeper 本機 MCP API，讓智慧代理能在一處管理你所有的聊天（iMessage、WhatsApp 等）。
</Card>

</CardGroup>

## 🤖 自動化與工作流

<CardGroup cols={2}>

<Card title="Winix 空氣清淨機控制" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  ** @antonplex** • `automation` `hardware` `air-quality`

Claude Code 發現並確認了清淨機控制項，接著由 OpenClaw 接手管理室內空氣品質。

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="透過 OpenClaw 控制 Winix 空氣清淨機" />
</Card>

<Card title="絕美天空攝影快照" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  ** @signalgaining** • `automation` `camera` `skill` `images`

由屋頂攝影機觸發：當天空看起來很美時，要求 OpenClaw 拍攝一張天空照片——它設計了一個 Skill 並完成了拍攝。

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="由 OpenClaw 擷取的屋頂攝影機天空快照" />
</Card>

<Card title="視覺化晨間簡報場景" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  ** @buddyhadry** • `automation` `briefing` `images` `telegram`

透過排程提示詞，每天早上經由 OpenClaw 人格產生一張單一的「場景」圖片（天氣、任務、日期、最愛的貼文/格言）。
</Card>

<Card title="Padel 球場預訂" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  ** @joshp123** • `automation` `booking` `cli`
  
  Playtomic 可訂位檢查器 + 預訂 CLI。再也不會錯過空出的球場。
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli 螢幕截圖" />
</Card>

<Card title="會計進項處理" icon="file-invoice-dollar">
  **社群** • `automation` `email` `pdf`
  
  從電子郵件收集 PDF，為稅務顧問準備文件。每月會計工作自動化運行。
</Card>

<Card title="沙發土豆開發模式" icon="couch" href="https://davekiss.com">
  ** @davekiss** • `telegram` `website` `migration` `astro`

邊看 Netflix 邊透過 Telegram 重建了整個個人網站——Notion 轉 Astro、遷移 18 篇文章、DNS 轉至 Cloudflare。完全沒打開過筆電。
</Card>

<Card title="求職智慧代理" icon="briefcase">
  ** @attol8** • `automation` `api` `skill`

搜尋職缺列表，比對履歷關鍵字，並回傳帶有連結的相關機會。使用 JSearch API 在 30 分鐘內建成。
</Card>

<Card title="Jira Skill 構建器" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  ** @jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw 連線至 Jira，然後即時產生了一個新的 Skill（在 ClawHub 出現之前）。
</Card>

<Card title="透過 Telegram 使用 Todoist Skill" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  ** @iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

自動化 Todoist 任務，並讓 OpenClaw 直接在 Telegram 聊天中產生 Skill。
</Card>

<Card title="TradingView 分析" icon="chart-line">
  ** @bheem1798** • `finance` `browser` `automation`

透過瀏覽器自動化登入 TradingView、擷取圖表螢幕截圖，並根據需求進行技術分析。無須 API——僅需瀏覽器控制。
</Card>

<Card title="Slack 自動支援" icon="slack">
  ** @henrymascot** • `slack` `automation` `support`

監看公司 Slack 頻道、提供有用的回饋，並將通知轉發至 Telegram。在未被要求的情況下，自主修復了已部署應用程式中的生產環境錯誤。
</Card>

</CardGroup>

## 🧠 知識與記憶體

<CardGroup cols={2}>

<Card title="xuezh 中文學習" icon="language" href="https://github.com/joshp123/xuezh">
  ** @joshp123** • `learning` `voice` `skill`
  
  帶有發音回饋與學習流的中文學習引擎，透過 OpenClaw 運作。
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh 發音回饋" />
</Card>

<Card title="WhatsApp 記憶保險庫" icon="vault">
  **社群** • `memory` `transcription` `indexing`
  
  匯入完整的 WhatsApp 匯出資料、轉錄 1,000+ 則語音訊息、與 git 紀錄進行交叉比對，並輸出帶有連結的 Markdown 報告。
</Card>

<Card title="Karakeep 語義搜尋" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  ** @jamesbrooksco** • `search` `vector` `bookmarks`
  
  使用 Qdrant + OpenAI/Ollama 嵌入模型為 Karakeep 書籤增加向量搜尋功能。
</Card>

<Card title="Inside-Out-2 記憶體" icon="brain">
  **社群** • `memory` `beliefs` `self-model`
  
  獨立的記憶體管理器，將工作階段檔案轉化為記憶 → 信念 → 持續進化的自我模型。
</Card>

</CardGroup>

## 🎙️ 語音與電話

<CardGroup cols={2}>

<Card title="Clawdia 電話橋接" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  ** @alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi 語音助手 ↔ OpenClaw HTTP 橋接。與你的智慧代理進行近乎即時的電話通話。
</Card>

<Card title="OpenRouter 語音轉錄" icon="microphone" href="https://clawhub.com/obviyus/openrouter-transcribe">
  ** @obviyus** • `transcription` `multilingual` `skill`

透過 OpenRouter (Gemini 等) 進行多國語言音訊轉錄。可在 ClawHub 上取得。
</Card>

</CardGroup>

## 🏗️ 基礎設施與部署

<CardGroup cols={2}>

<Card title="Home Assistant Add-on" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  ** @ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  在 Home Assistant OS 上運行的 OpenClaw Gateway，支援 SSH 通道與持久化狀態。
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.com/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  透過自然語言控制並自動化 Home Assistant 裝置。
</Card>

<Card title="Nix 封裝" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  ** @start/openclaw.md • `nix` `packaging` `deployment`
  
  功能完備的 Nix 化 OpenClaw 設定，用於可重現的部署。
</Card>

<Card title="CalDAV 行事曆" icon="calendar" href="https://clawhub.com/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  使用 khal/vdirsyncer 的行事曆 Skill。自託管行事曆整合。
</Card>

</CardGroup>

## 🏠 居家與硬體

<CardGroup cols={2}>

<Card title="GoHome 自動化" icon="house-signal" href="https://github.com/joshp123/gohome">
  ** @joshp123** • `home` `nix` `grafana`
  
  Nix 原生居家自動化，以 OpenClaw 作為介面，並配有美觀的 Grafana 儀表板。
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana 儀表板" />
</Card>

<Card title="石頭掃地機器人 (Roborock Vacuum)" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  ** @joshp123** • `vacuum` `iot` `plugin`
  
  透過自然對話控制你的石頭掃地機器人。
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="石頭掃地機器人狀態" />
</Card>

</CardGroup>

## 🌟 社群專案

<CardGroup cols={2}>

<Card title="StarSwap 市集" icon="star" href="https://star-swap.com/">
  **社群** • `marketplace` `astronomy` `webapp`
  
  完整的天文器材市集。圍繞 OpenClaw 生態系統構建。
</Card>

</CardGroup>

---

## 提交你的專案

有作品想分享嗎？我們很樂意為你展示！

<Steps>
  <Step title="分享作品">
    在 [Discord 的 #showcase 頻道](https://discord.gg/clawd) 發文，或 [推文標記 @start/openclaw.md](https://x.com/openclaw)
  </Step>
  <Step title="包含詳細資訊">
    告訴我們它的功能、附上存放庫/展示連結、如果有螢幕截圖也請一併分享
  </Step>
  <Step title="獲得展示">
    我們會將優秀的專案加入此頁面
  </Step>
</Steps>
