---
summary: "OpenClaw plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
title: Plugins
---

# 插件（擴充功能）

## 快速開始（剛接觸插件？）

插件就是一個**小型程式模組**，用來為 OpenClaw 擴充額外功能（指令、工具和 Gateway RPC）。

大多數時候，當你需要 OpenClaw 核心尚未內建的功能，或想把選用功能從主要安裝中分離出來時，就會使用插件。

快速路徑：

1. 查看目前已載入的插件：

```bash
openclaw plugins list
```

2. 安裝官方插件（範例：語音通話）：

```bash
openclaw plugins install @openclaw/voice-call
```

Npm 規格只接受**註冊表套件名稱**加上可選的**精確版本**或**發行標籤（dist-tag）**。Git/URL/檔案規格和 semver 範圍會被拒絕。

裸規格和 `@latest` 會維持在穩定版本路線。如果 npm 將它們解析為預發行版本，OpenClaw 會停止並要求你明確選擇使用預發行標籤，如 `@beta`/`@rc` 或精確的預發行版本。

3. 重新啟動 Gateway，然後在 `plugins.entries.<id>.config` 下進行設定。

請參考 [語音通話](/plugins/voice-call) 了解具體範例插件。
想找第三方插件列表？請見 [社群插件](/plugins/community)。

## 架構

OpenClaw 的插件系統有四個層級：

1. **清單 + 探索**  
   OpenClaw 從已設定的路徑、工作區根目錄、全域擴充根目錄以及內建擴充中尋找候選插件。探索階段會先讀取 `openclaw.plugin.json` 以及套件元資料。
2. **啟用 + 驗證**  
   核心決定已發現的插件是啟用、停用、封鎖，或是被選為專屬插槽（例如記憶體）。
3. **執行時載入**  
   啟用的插件會透過 jiti 在同一程序中載入，並將功能註冊到中央註冊表。
4. **介面消費**  
   OpenClaw 其餘部分會讀取註冊表，來暴露工具、通道、提供者設定、掛勾、HTTP 路由、CLI 指令及服務。

重要的設計界限：

- 探索與設定驗證應該從 **清單/結構元資料** 工作，且不執行插件程式碼
- 執行時行為來自插件模組的 `register(api)` 路徑

這樣的分離讓 OpenClaw 能在完整執行時啟動前，驗證設定、說明缺少或停用的插件，並建立 UI/結構提示。

## 執行模型

插件與 Gateway 同程序執行，沒有沙箱隔離。已載入的插件與核心程式碼擁有相同的程序層級信任邊界。

影響：

- 插件可以註冊工具、網路處理器、掛勾及服務
- 插件錯誤可能導致 Gateway 崩潰或不穩定
- 惡意插件等同於在 OpenClaw 程序內執行任意程式碼

對非內建插件請使用允許清單及明確的安裝/載入路徑。將工作區插件視為開發時期程式碼，而非生產預設。

## 可用插件（官方）

- Microsoft Teams 從 2026.1.15 起僅限插件形式；若使用 Teams 請安裝 `@openclaw/msteams`。
- Memory (Core) — 內建記憶搜尋插件（預設透過 `plugins.slots.memory` 啟用）
- Memory (LanceDB) — 內建長期記憶插件（自動回憶/捕捉；設定 `plugins.slots.memory = "memory-lancedb"`）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth（提供者認證）— 內建為 `google-antigravity-auth`（預設停用）
- Gemini CLI OAuth（提供者認證）— 內建為 `google-gemini-cli-auth`（預設停用）
- Qwen OAuth（提供者認證）— 內建為 `qwen-portal-auth`（預設停用）
- Copilot Proxy（提供者認證）— 本地 VS Code Copilot Proxy 橋接；與內建 `github-copilot` 裝置登入不同（內建，預設停用）

OpenClaw 插件是透過 jiti 在執行時載入的 **TypeScript 模組**。**設定驗證不會執行插件程式碼**，而是使用插件清單與 JSON 結構。詳見 [插件清單](/plugins/manifest)。

插件可以註冊：

- Gateway RPC 方法
- Gateway HTTP 路由
- 代理工具
- CLI 指令
- 背景服務
- 上下文引擎
- 選用的設定驗證
- **技能**（透過在插件清單中列出 `skills` 目錄）
- **自動回覆指令**（執行時不會呼叫 AI 代理）

插件與 Gateway 同程序執行，因此請將它們視為受信任的程式碼。工具開發指南：[插件代理工具](/plugins/agent-tools)。

## 載入流程

啟動時，OpenClaw 大致執行以下步驟：

1. 探測候選插件根目錄
2. 讀取 `openclaw.plugin.json` 與套件元資料
3. 拒絕不安全的候選專案
4. 正規化插件設定 (`plugins.enabled`, `allow`, `deny`, `entries`,  
   `slots`, `load.paths`)
5. 決定每個候選專案的啟用狀態
6. 透過 jiti 載入已啟用的模組
7. 呼叫 `register(api)` 並將註冊資訊收集到插件註冊表中
8. 將註冊表暴露給指令/執行時介面

安全檢查會在執行時之前進行。當入口路徑超出插件根目錄、路徑為全域可寫，或非打包插件的路徑擁有權看起來可疑時，候選專案會被阻擋。

### 以清單為先的行為

清單是控制平面的真實來源。OpenClaw 利用它來：

- 識別插件
- 探測宣告的頻道/技能/設定結構
- 驗證 `plugins.entries.<id>.config`
- 增強控制介面的標籤與佔位文字
- 顯示安裝/目錄元資料

執行時模組則是資料平面部分。它註冊實際行為，如掛勾、工具、指令或提供者流程。

### 載入器快取內容

OpenClaw 會維持短暫的程序內快取，用於：

- 探測結果
- 清單註冊資料
- 已載入的插件註冊表

這些快取能減少啟動時的突發負載與重複指令的開銷。它們可視為短期效能快取，而非持久化資料。

## 執行時輔助工具

插件可以透過 `api.runtime` 存取特定核心輔助工具。以語音電話 TTS 為例：

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

說明：

- 使用核心 `messages.tts` 設定（OpenAI 或 ElevenLabs）。
- 回傳 PCM 音訊緩衝區與取樣率。插件必須為各供應商進行重取樣/編碼。
- 電話語音不支援 Edge TTS。

對於 STT/轉錄，插件可以呼叫：

```ts
const { text } = await api.runtime.stt.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // Optional when MIME cannot be inferred reliably:
  mime: "audio/ogg",
});
```

說明：

- 使用核心媒體理解音訊設定（`tools.media.audio`）及供應商備援順序。
- 當無轉錄輸出（例如跳過或不支援的輸入）時，回傳 `{ text: undefined }`。

## Gateway HTTP 路由

插件可以使用 `api.registerHttpRoute(...)` 來暴露 HTTP 端點。

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

路由欄位：

- `path`：Gateway HTTP 伺服器下的路由路徑。
- `auth`：必填。使用 `"gateway"` 以要求一般 Gateway 認證，或使用 `"plugin"` 以進行插件管理的認證/Webhook 驗證。
- `match`：選填。可為 `"exact"`（預設）或 `"prefix"`。
- `replaceExisting`：選填。允許同一插件取代其已存在的路由註冊。
- `handler`：當路由處理請求時，回傳 `true`。

說明：

- `api.registerHttpHandler(...)` 已過時，請改用 `api.registerHttpRoute(...)`。
- 插件路由必須明確宣告 `auth`。
- 除非有 `replaceExisting: true`，否則完全相同的 `path + match` 衝突會被拒絕，且一個插件無法取代另一插件的路由。
- 不同 `auth` 等級的重疊路由會被拒絕。請保持 `exact`/`prefix` 的穿透鏈僅在相同認證等級內。

## 插件 SDK 匯入路徑

撰寫插件時，請使用 SDK 子路徑，取代單一的 `openclaw/plugin-sdk` 匯入：

- `openclaw/plugin-sdk/core` 用於通用插件 API、提供者認證類型及共用輔助函式。
- `openclaw/plugin-sdk/compat` 用於內建/內部插件程式碼，需比 `core` 更廣泛的共用執行時輔助函式。
- `openclaw/plugin-sdk/telegram` 用於 Telegram 頻道插件。
- `openclaw/plugin-sdk/discord` 用於 Discord 頻道插件。
- `openclaw/plugin-sdk/slack` 用於 Slack 頻道插件。
- `openclaw/plugin-sdk/signal` 用於 Signal 頻道插件。
- `openclaw/plugin-sdk/imessage` 用於 iMessage 頻道插件。
- `openclaw/plugin-sdk/whatsapp` 用於 WhatsApp 頻道插件。
- `openclaw/plugin-sdk/line` 用於 LINE 頻道插件。
- `openclaw/plugin-sdk/msteams` 用於內建 Microsoft Teams 插件介面。
- 也提供內建擴充功能專用子路徑：
  `openclaw/plugin-sdk/acpx`, `openclaw/plugin-sdk/bluebubbles`,
  `openclaw/plugin-sdk/copilot-proxy`, `openclaw/plugin-sdk/device-pair`,
  `openclaw/plugin-sdk/diagnostics-otel`, `openclaw/plugin-sdk/diffs`,
  `openclaw/plugin-sdk/feishu`,
  `openclaw/plugin-sdk/google-gemini-cli-auth`, `openclaw/plugin-sdk/googlechat`,
  `openclaw/plugin-sdk/irc`, `openclaw/plugin-sdk/llm-task`,
  `openclaw/plugin-sdk/lobster`, `openclaw/plugin-sdk/matrix`,
  `openclaw/plugin-sdk/mattermost`, `openclaw/plugin-sdk/memory-core`,
  `openclaw/plugin-sdk/memory-lancedb`,
  `openclaw/plugin-sdk/minimax-portal-auth`,
  `openclaw/plugin-sdk/nextcloud-talk`, `openclaw/plugin-sdk/nostr`,
  `openclaw/plugin-sdk/open-prose`, `openclaw/plugin-sdk/phone-control`,
  `openclaw/plugin-sdk/qwen-portal-auth`, `openclaw/plugin-sdk/synology-chat`,
  `openclaw/plugin-sdk/talk-voice`, `openclaw/plugin-sdk/test-utils`,
  `openclaw/plugin-sdk/thread-ownership`, `openclaw/plugin-sdk/tlon`,
  `openclaw/plugin-sdk/twitch`, `openclaw/plugin-sdk/voice-call`,
  `openclaw/plugin-sdk/zalo`, 以及 `openclaw/plugin-sdk/zalouser`。

相容性說明：

- `openclaw/plugin-sdk` 仍支援現有外部插件。
- 新增及遷移的內建插件應使用頻道或擴充功能專用子路徑；通用介面請使用 `core`，僅在需要更廣泛共用輔助函式時使用 `compat`。

## 只讀頻道檢查

如果您的插件註冊了一個頻道，建議同時實作 `plugin.config.inspectAccount(cfg, accountId)` 和 `resolveAccount(...)`。

原因：

- `resolveAccount(...)` 是執行時路徑。允許假設憑證已完全具現，且在缺少必要祕密時可快速失敗。
- 只讀指令路徑如 `openclaw status`、`openclaw status --all`、`openclaw channels status`、`openclaw channels resolve` 以及診斷/設定修復流程，不應該為了描述設定而必須具現執行時憑證。

建議的 `inspectAccount(...)` 行為：

- 僅回傳描述性帳戶狀態。
- 保留 `enabled` 和 `configured`。
- 在相關情況下包含憑證來源/狀態欄位，例如：
  - `tokenSource`, `tokenStatus`
  - `botTokenSource`, `botTokenStatus`
  - `appTokenSource`, `appTokenStatus`
  - `signingSecretSource`, `signingSecretStatus`
- 不需要回傳原始 token 值來報告只讀可用性。回傳 `tokenStatus: "available"`（及相對應的來源欄位）即可滿足狀態類指令需求。
- 當憑證是透過 SecretRef 設定但在當前指令路徑中不可用時，請使用 `configured_unavailable`。

這讓只讀指令能報告「已設定但在此指令路徑中不可用」，避免崩潰或錯誤報告帳戶未設定。

效能說明：

- 插件發現與清單元資料使用短期進程內快取，以減少突發啟動/重新載入工作量。
- 設定 `OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1` 或 `OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1` 可停用這些快取。
- 可透過 `OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS` 和 `OPENCLAW_PLUGIN_MANIFEST_CACHE_MS` 調整快取時間窗口。

## 掃描與優先順序

OpenClaw 掃描順序：

1. 設定路徑

- `plugins.load.paths`（檔案或目錄）

2. 工作區擴充功能

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 全域擴充功能

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 內建擴充功能（隨 OpenClaw 一起發行，大多數預設為停用）

- `<openclaw>/extensions/*`

大多數內建插件必須透過 `plugins.entries.<id>.enabled` 或 `openclaw plugins enable <id>` 明確啟用。

預設啟用的內建插件例外：

- `device-pair`
- `phone-control`
- `talk-voice`
- 活動記憶體槽插件（預設槽位：`memory-core`）

已安裝的插件預設為啟用，但也可以用相同方式停用。

工作區插件**預設為停用**，除非你明確啟用或允許清單中包含。這是刻意設計：檢出的程式碼庫不應該無聲無息地變成生產閘道程式碼。

強化說明：

- 如果 `plugins.allow` 為空且可發現非內建插件，OpenClaw 會在啟動時記錄包含插件 ID 和來源的警告。
- 候選路徑在允許發現前會進行安全檢查。OpenClaw 會阻擋以下候選路徑：
  - 擴充功能入口解析結果位於插件根目錄外（包含符號連結/路徑穿越逃逸），
  - 插件根目錄或來源路徑為全域可寫，
  - 非內建插件的路徑擁有權可疑（POSIX 擁有者既非當前使用者 ID 也非 root）。
- 載入的非內建插件若無安裝或載入路徑來源，會發出警告，方便你釘選信任 (`plugins.allow`) 或安裝追蹤 (`plugins.installs`)。

每個插件根目錄必須包含一個 `openclaw.plugin.json` 檔案。如果路徑指向檔案，插件根目錄即為該檔案所在目錄，且該目錄必須包含此清單。

如果多個插件解析到相同的 id，以上述順序中第一個匹配的插件勝出，較低優先權的副本將被忽略。

### 啟用規則

啟用是在發現之後解析：

- `plugins.enabled: false` 禁用所有插件
- `plugins.deny` 永遠勝出
- `plugins.entries.<id>.enabled: false` 禁用該插件
- 工作區來源的插件預設被禁用
- 當 `plugins.allow` 非空時，允許清單限制啟用的插件集合
- 預設捆綁的插件預設被禁用，除非：
  - 該捆綁 id 在內建的預設啟用集合中，或
  - 你明確啟用它，或
  - 頻道設定隱式啟用該捆綁頻道插件
- 專屬插槽可以強制啟用該插槽選定的插件

在目前核心中，預設啟用的捆綁 id 包含本地/提供者輔助插件，如 `ollama`、`sglang`、`vllm`，以及 `device-pair`、`phone-control` 和 `talk-voice`。

### 套件包

插件目錄可以包含帶有 `openclaw.extensions` 的 `package.json`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

每個條目都會成為一個插件。如果套件列出多個擴充，插件 id 將成為 `name/<fileBase>`。

如果你的插件匯入 npm 依賴，請在該目錄安裝它們，以便 `node_modules` 可用（`npm install` / `pnpm install`）。

安全防護：每個 `openclaw.extensions` 條目在符號連結解析後必須留在插件目錄內。逃離套件目錄的條目將被拒絕。

安全說明：`openclaw plugins install` 使用 `npm install --ignore-scripts` 安裝插件依賴（無生命週期腳本）。保持插件依賴樹為「純 JS/TS」，避免使用需要 `postinstall` 編譯的套件。

### 頻道目錄元資料

頻道插件可以透過 `openclaw.channel` 廣告上線元資料，並透過 `openclaw.install` 提供安裝提示。這讓核心目錄保持無資料狀態。

範例：

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw 也可以合併 **外部頻道目錄**（例如，MPM 登入匯出）。將 JSON 檔案放到以下任一位置：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或將 `OPENCLAW_PLUGIN_CATALOG_PATHS`（或 `OPENCLAW_MPM_CATALOG_PATHS`）指向一個或多個 JSON 檔案（以逗號、分號或 `PATH` 分隔）。每個檔案應包含 `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`。

## 外掛 ID

預設外掛 ID：

- 套件包：`package.json` `name`
- 獨立檔案：檔案基本名稱（`~/.../voice-call.ts` → `voice-call`）

如果外掛匯出 `id`，OpenClaw 會使用它，但若與設定的 ID 不符會發出警告。

## 登入模型

已載入的外掛不會直接修改任意核心全域變數。它們會註冊到中央外掛登入中。

登入會追蹤：

- 外掛紀錄（身份、來源、起源、狀態、診斷）
- 工具
- 舊版掛勾與型別掛勾
- 頻道
- 提供者
- 閘道 RPC 處理器
- HTTP 路由
- CLI 註冊器
- 背景服務
- 外掛擁有的指令

核心功能接著從該登入讀取，而非直接與外掛模組互動。這保持載入流程單向：

- 外掛模組 -> 登入註冊
- 核心執行時 -> 登入使用

這種分離對維護性很重要。它代表大多數核心介面只需一個整合點：「讀取登入」，而非「針對每個外掛模組特別處理」。

## 設定

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

欄位：

- `enabled`：主開關（預設：true）
- `allow`：允許清單（選填）
- `deny`：拒絕清單（選填；拒絕優先）
- `load.paths`：額外的外掛檔案/目錄
- `slots`：專屬插槽選擇器，如 `memory` 和 `contextEngine`
- `entries.<id>`：每個外掛的開關與設定

設定變更**需要重新啟動閘道器**。

驗證規則（嚴格）：

- 在 `entries`、`allow`、`deny` 或 `slots` 中出現未知的外掛 ID 是**錯誤**。
- 除非外掛清單宣告了頻道 ID，否則未知的 `channels.<id>` 鍵是**錯誤**。
- 外掛設定會使用嵌入在 `openclaw.plugin.json` (`configSchema`) 中的 JSON Schema 進行驗證。
- 若外掛被停用，其設定會被保留，並會發出**警告**。

### 停用、遺失與無效的差異

這些狀態是刻意區分的：

- **停用**：外掛存在，但啟用規則將其關閉
- **遺失**：設定參考了發現不到的外掛 ID
- **無效**：外掛存在，但其設定不符合宣告的 Schema

OpenClaw 會保留停用外掛的設定，以便重新啟用時不會造成破壞。

## 外掛插槽（專屬類別）

某些外掛類別是**專屬的**（同時只允許一個啟用）。使用
`plugins.slots` 選擇哪個外掛擁有該插槽：

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
      contextEngine: "legacy", // or a plugin id such as "lossless-claw"
    },
  },
}
```

支援的專屬插槽：

- `memory`：啟用記憶體插件（`"none"` 會停用記憶體插件）
- `contextEngine`：啟用上下文引擎插件（`"legacy"` 是內建預設）

如果多個插件宣告了 `kind: "memory"` 或 `kind: "context-engine"`，該插槽只會載入被選擇的插件。其他插件會被停用並顯示診斷訊息。

### 上下文引擎插件

上下文引擎插件負責會話上下文的協調，包括資料擷取、組裝與壓縮。從你的插件中使用 `api.registerContextEngine(id, factory)` 註冊它們，然後用 `plugins.slots.contextEngine` 選擇啟用的引擎。

當你的插件需要取代或擴充預設的上下文流程，而不只是新增記憶體搜尋或掛勾時，請使用此功能。

## 控制介面（結構 + 標籤）

控制介面使用 `config.schema`（JSON Schema + `uiHints`）來呈現更完善的表單。

OpenClaw 會根據偵測到的插件，在執行時擴充 `uiHints`：

- 為每個插件新增 `plugins.entries.<id>` / `.enabled` / `.config` 的標籤
- 將插件提供的可選設定欄位提示合併到：
  `plugins.entries.<id>.config.<field>`

如果你希望你的插件設定欄位顯示良好的標籤/佔位符（並將機密標記為敏感），請在插件清單中與 JSON Schema 一起提供 `uiHints`。

範例：

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins install @openclaw/voice-call --pin # store exact resolved name@version
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` 僅適用於在 `plugins.installs` 下追蹤的 npm 安裝。
如果更新時儲存的完整性元資料有變更，OpenClaw 會警告並要求確認（可使用全域 `--yes` 來跳過提示）。

外掛也可以註冊自己的頂層指令（範例：`openclaw voicecall`）。

## 外掛 API（概覽）

外掛會匯出以下其中一種：

- 一個函式：`(api) => { ... }`
- 一個物件：`{ id, name, configSchema, register(api) { ... } }`

`register(api)` 是外掛附加行為的地方。常見的註冊專案包括：

- `registerTool`
- `registerHook`
- `on(...)` 用於型別化的生命週期鉤子
- `registerChannel`
- `registerProvider`
- `registerHttpRoute`
- `registerCommand`
- `registerCli`
- `registerContextEngine`
- `registerService`

Context engine 外掛也可以註冊一個由執行時管理的 context 管理器：

```ts
export default function (api) {
  api.registerContextEngine("lossless-claw", () => ({
    info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

然後在設定中啟用它：

```json5
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw",
    },
  },
}
```

## 外掛鉤子

外掛可以在執行時註冊鉤子。這讓外掛能夠捆綁事件驅動的自動化，而不需另外安裝鉤子套件。

### 範例

```ts
export default function register(api) {
  api.registerHook(
    "command:new",
    async () => {
      // Hook logic here.
    },
    {
      name: "my-plugin.command-new",
      description: "Runs when /new is invoked",
    },
  );
}
```

備註：

- 透過 `api.registerHook(...)` 明確註冊 hooks。
- 仍需遵守 hook 的資格規則（作業系統/二進位檔/環境/設定要求）。
- 插件管理的 hooks 會在 `openclaw hooks list` 中顯示，並帶有 `plugin:<id>`。
- 無法透過 `openclaw hooks` 啟用/停用插件管理的 hooks；請改為啟用/停用整個插件。

### Agent 生命週期 hooks (`api.on`)

對於有型別的執行時生命週期 hooks，請使用 `api.on(...)`：

```ts
export default function register(api) {
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      return {
        prependSystemContext: "Follow company style guide.",
      };
    },
    { priority: 10 },
  );
}
```

提示構建的重要 hooks：

- `before_model_resolve`：在會話載入前執行（`messages` 尚不可用）。用於確定性地覆寫 `modelOverride` 或 `providerOverride`。
- `before_prompt_build`：在會話載入後執行（`messages` 可用）。用於調整提示輸入。
- `before_agent_start`：舊版相容性 hook。建議優先使用上述兩個明確的 hooks。

核心強制的 hook 政策：

- 操作者可透過 `plugins.entries.<id>.hooks.allowPromptInjection: false` 針對每個插件停用提示變更 hooks。
- 停用時，OpenClaw 會阻擋 `before_prompt_build`，並忽略舊版 `before_agent_start` 回傳的提示變更欄位，同時保留舊版的 `modelOverride` 和 `providerOverride`。

`before_prompt_build` 回傳欄位：

- `prependContext`：在本次執行的使用者提示前加上文字。適合用於特定回合或動態內容。
- `systemPrompt`：完整覆寫系統提示。
- `prependSystemContext`：在目前系統提示前加上文字。
- `appendSystemContext`：在目前系統提示後加上文字。

嵌入式執行時的提示構建順序：

1. 對使用者提示套用 `prependContext`。
2. 若有提供，套用 `systemPrompt` 覆寫。
3. 套用 `prependSystemContext + current system prompt + appendSystemContext`。

合併與優先權說明：

- hook 處理程序依優先權執行（優先權高者先執行）。
- 對於合併的上下文字段，值會依執行順序串接。
- `before_prompt_build` 的值會先於舊版 `before_agent_start` 的備援值套用。

遷移指引：

- 將靜態指引從 `prependContext` 移動到 `prependSystemContext`（或 `appendSystemContext`），以便提供者能快取穩定的系統前綴內容。
- 保留 `prependContext` 用於每回合的動態上下文，該上下文應與使用者訊息綁定。

## 提供者插件（模型認證）

插件可以註冊 **模型提供者**，讓使用者能在 OpenClaw 內執行 OAuth 或 API 金鑰設定，並在新手引導/模型選擇器中顯示提供者設定，還能貢獻隱式提供者發現。

提供者插件是模型提供者設定的模組化擴充接口。它們不再只是「OAuth 輔助工具」。

### 提供者插件生命週期

提供者插件可以參與五個不同階段：

1. **認證**  
   `auth[].run(ctx)` 執行 OAuth、API 金鑰擷取、裝置程式碼或自訂設定，並回傳認證設定檔及可選的設定補丁。
2. **非互動式設定**  
   `auth[].runNonInteractive(ctx)` 處理 `openclaw onboard --non-interactive`，不會有提示。當提供者需要超出內建簡易 API 金鑰路徑的自訂無頭設定時使用。
3. **精靈整合**  
   `wizard.onboarding` 新增一個專案到 `openclaw onboard`。  
   `wizard.modelPicker` 在模型選擇器中新增設定專案。
4. **隱式發現**  
   `discovery.run(ctx)` 可在模型解析/列出時自動貢獻提供者設定。
5. **選擇後跟進**  
   `onModelSelected(ctx)` 在模型被選擇後執行。用於提供者特定工作，例如下載本地模型。

建議如此分階段，因為這些階段有不同的生命週期需求：

- 認證是互動式且會寫入憑證/設定
- 非互動式設定由旗標/環境變數驅動，且不得提示使用者
- 精靈元資料是靜態且面向 UI
- 發現應該安全、快速且容錯
- 選擇後掛勾是與所選模型綁定的副作用

### 提供者認證合約

`auth[].run(ctx)` 回傳：

- `profiles`：要寫入的認證設定檔
- `configPatch`：可選的 `openclaw.json` 變更
- `defaultModel`：可選的 `provider/model` 參考
- `notes`：可選的面向使用者的說明

核心接著會：

1. 寫入回傳的認證設定檔
2. 套用認證設定檔的設定連結
3. 合併設定補丁
4. 選擇性套用預設模型
5. 在適當時機執行提供者的 `onModelSelected` 掛勾

這表示提供者插件負責提供者特定的設定邏輯，而核心負責通用的持久化與設定合併流程。

### 非互動式提供者合約

`auth[].runNonInteractive(ctx)` 是可選的。當提供者需要無頭設定且無法透過內建的通用 API 金鑰流程表達時，請實作它。

非互動式上下文包含：

- 當前與基底設定
- 解析後的 onboarding CLI 選項
- 執行時的日誌/錯誤輔助工具
- 代理/工作區目錄
- `resolveApiKey(...)` 用於從旗標、環境變數或現有認證設定檔讀取提供者金鑰，同時遵守 `--secret-input-mode`
- `toApiKeyCredential(...)` 將解析後的金鑰轉換成具有正確明文與秘密參考存儲的認證設定檔憑證

此介面適用於以下提供者：

- 需要 `--custom-base-url` + `--custom-model-id` 的自架設 OpenAI 相容執行環境
- 提供者專屬的非互動式驗證或設定合成

請勿從 `runNonInteractive` 進行提示。缺少輸入時應以可操作的錯誤拒絕。

### 提供者精靈元資料

`wizard.onboarding` 控制提供者在分組 onboarding 中的顯示方式：

- `choiceId`：認證選擇值
- `choiceLabel`：選項標籤
- `choiceHint`：簡短提示
- `groupId`：分組桶 ID
- `groupLabel`：分組標籤
- `groupHint`：分組提示
- `methodId`：要執行的認證方法

`wizard.modelPicker` 控制提供者在模型選擇中作為「立即設定」專案的顯示方式：

- `label`
- `hint`
- `methodId`

當提供者有多個認證方法時，精靈可以指向一個明確的方法，或讓 OpenClaw 合成每個方法的選擇。

OpenClaw 在外掛註冊時會驗證提供者精靈元資料：

- 重複或空白的認證方法 ID 會被拒絕
- 當提供者沒有認證方法時，精靈元資料會被忽略
- 無效的 `methodId` 綁定會降級為警告，並回退到提供者剩餘的認證方法

### 提供者發現合約

`discovery.run(ctx)` 回傳以下其中一項：

- `{ provider }`
- `{ providers }`
- `null`

當外掛擁有單一提供者 ID 時，使用 `{ provider }`。
當外掛發現多個提供者條目時，使用 `{ providers }`。

發現上下文包含：

- 當前設定
- 代理/工作區目錄
- 程式環境變數
- 用於解析提供者 API 金鑰及安全發現用 API 金鑰值的輔助工具

發現應該是：

- 快速
- 盡力而為
- 失敗時可安全跳過
- 注意副作用

不應依賴提示或長時間的設定程序。

### 發現排序

提供者發現依序在階段中執行：

- `simple`
- `profile`
- `paired`
- `late`

使用：

- `simple` 用於廉價的僅環境發現
- `profile` 當發現依賴於認證設定檔時
- `paired` 用於需要與其他發現步驟協調的提供者
- `late` 用於昂貴或本地網路探測

大多數自架設提供者應使用 `late`。

### 良好的 provider-plugin 邊界

適合用於 provider 插件的情境：

- 本地或自架設的 provider，具有自訂設定流程
- provider 專屬的 OAuth / 裝置碼登入
- 本地模型伺服器的隱式發現
- 選擇後的副作用，例如模型拉取

較不適合的情境：

- 僅以環境變數、基底 URL 和一個預設模型區別的簡單 API key-only provider

這些仍可成為插件，但主要的模組化效益來自先抽取行為豐富的 provider。

透過 `api.registerProvider(...)` 註冊 provider。每個 provider 可暴露一種或多種認證方法（OAuth、API key、裝置碼等）。這些方法可用於：

- `openclaw models auth login --provider <id> [--method <id>]`
- `openclaw onboard`
- 模型選擇器中的「自訂 provider」設定專案
- 模型解析/列出時的隱式 provider 發現

範例：

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
  wizard: {
    onboarding: {
      choiceId: "acme",
      choiceLabel: "AcmeAI",
      groupId: "acme",
      groupLabel: "AcmeAI",
      methodId: "oauth",
    },
    modelPicker: {
      label: "AcmeAI (custom)",
      hint: "Connect a self-hosted AcmeAI endpoint",
      methodId: "oauth",
    },
  },
  discovery: {
    order: "late",
    run: async () => ({
      provider: {
        baseUrl: "https://acme.example/v1",
        api: "openai-completions",
        apiKey: "${ACME_API_KEY}",
        models: [],
      },
    }),
  },
});
```

說明：

- `run` 接收帶有 `prompter`、`runtime`、`openUrl` 和 `oauth.createVpsAwareHandlers` 輔助功能的 `ProviderAuthContext`。
- `runNonInteractive` 接收帶有 `opts`、`resolveApiKey` 和 `toApiKeyCredential` 輔助功能的 `ProviderAuthMethodNonInteractiveContext`，用於無頭上線流程。
- 需要新增預設模型或 provider 設定時，回傳 `configPatch`。
- 回傳 `defaultModel` 以便 `--set-default` 更新代理預設值。
- `wizard.onboarding` 將 provider 選項加入 `openclaw onboard`。
- `wizard.modelPicker` 在模型選擇器中新增「設定此 provider」專案。
- `discovery.run` 回傳插件自身 provider id 的 `{ provider }`，或多 provider 發現用的 `{ providers }`。
- `discovery.order` 控制 provider 執行時機，相對於內建發現階段：`simple`、`profile`、`paired` 或 `late`。
- `onModelSelected` 是選擇後的掛勾，用於 provider 專屬的後續工作，例如拉取本地模型。

### 註冊訊息通道

插件可以註冊 **channel plugins**，其行為類似內建通道（WhatsApp、Telegram 等）。通道設定存放於 `channels.<id>`，並由你的通道插件程式碼驗證。

ts
const myChannel = {
id: "acmechat",
meta: {
id: "acmechat",
label: "AcmeChat",
selectionLabel: "AcmeChat (API)",
docsPath: "/channels/acmechat",
blurb: "demo channel plugin.",
aliases: ["acme"],
},
capabilities: { chatTypes: ["direct"] },
config: {
listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
resolveAccount: (cfg, accountId) =>
cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
accountId,
},
},
outbound: {
deliveryMode: "direct",
sendText: async () => ({ ok: true }),
},
};

export default function (api) {
api.registerChannel({ plugin: myChannel });
}

說明：

- 將設定放在 `channels.<id>` 下（而非 `plugins.entries`）。
- `meta.label` 用於 CLI/UI 列表中的標籤。
- `meta.aliases` 用來新增替代 ID，方便正規化及 CLI 輸入。
- `meta.preferOver` 列出當兩者都設定時，跳過自動啟用的頻道 ID。
- `meta.detailLabel` 和 `meta.systemImage` 讓 UI 顯示更豐富的頻道標籤/圖示。

### 頻道啟用鉤子（onboarding hooks）

頻道插件可在 `plugin.onboarding` 定義選用的啟用鉤子：

- `configure(ctx)` 是基礎的設定流程。
- `configureInteractive(ctx)` 可完全掌控互動式設定，適用於已設定及未設定狀態。
- `configureWhenConfigured(ctx)` 僅覆寫已設定頻道的行為。

精靈（wizard）中的鉤子優先順序：

1. `configureInteractive`（若存在）
2. `configureWhenConfigured`（僅當頻道狀態已設定時）
3. 回退至 `configure`

上下文細節：

- `configureInteractive` 和 `configureWhenConfigured` 接收：
  - `configured`（`true` 或 `false`）
  - `label`（用於提示的使用者面向頻道名稱）
  - 以及共用的 config/runtime/prompter/options 欄位
- 回傳 `"skip"` 表示保持選擇和帳號追蹤不變。
- 回傳 `{ cfg, accountId? }` 則套用設定更新並記錄帳號選擇。

### 撰寫新的訊息頻道（逐步教學）

當你想要一個**新的聊天介面**（「訊息頻道」），而非模型提供者時，請使用此方法。
模型提供者文件位於 `/providers/*`。

1. 選擇一個 ID 與設定結構

- 所有頻道設定皆放在 `channels.<id>` 下。
- 多帳號設定建議使用 `channels.<id>.accounts.<accountId>`。

2. 定義頻道元資料

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` 控制 CLI/UI 列表。
- `meta.docsPath` 應該指向像 `/channels/<id>` 這樣的文件頁面。
- `meta.preferOver` 允許一個插件取代另一個頻道（自動啟用時偏好使用它）。
- `meta.detailLabel` 和 `meta.systemImage` 被 UI 用於詳細文字/圖示。

3. 實作所需的適配器

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities`（聊天類型、媒體、討論串等）
- `outbound.deliveryMode` + `outbound.sendText`（用於基本發送）

4. 根據需要新增可選適配器

- `setup`（精靈）、`security`（私訊政策）、`status`（健康/診斷）
- `gateway`（啟動/停止/登入）、`mentions`、`threading`、`streaming`
- `actions`（訊息操作）、`commands`（原生指令行為）

5. 在你的插件中註冊頻道

- `api.registerChannel({ plugin })`

最小設定範例：

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

最小頻道插件（僅出站）：

ts
const plugin = {
id: "acmechat",
meta: {
id: "acmechat",
label: "AcmeChat",
selectionLabel: "AcmeChat (API)",
docsPath: "/channels/acmechat",
blurb: "AcmeChat 訊息頻道。",
aliases: ["acme"],
},
capabilities: { chatTypes: ["direct"] },
config: {
listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
resolveAccount: (cfg, accountId) =>
cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
accountId,
},
},
outbound: {
deliveryMode: "direct",
sendText: async ({ text }) => {
// 在此將 `text` 傳送到你的頻道
return { ok: true };
},
},
};

export default function (api) {
api.registerChannel({ plugin });
}

載入插件（extensions 目錄或 `plugins.load.paths`），重新啟動 gateway，
然後在你的設定中設定 `channels.<id>`。

### 代理工具

請參考專門的指南：[Plugin agent tools](/plugins/agent-tools)。

### 註冊 gateway RPC 方法

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### 註冊 CLI 指令

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### 註冊自動回覆指令

插件可以註冊自訂的斜線指令，這些指令執行時**不會呼叫 AI 代理**。這對於切換指令、狀態檢查或不需要 LLM 處理的快速操作非常有用。

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

指令處理器上下文：

- `senderId`：發送者的 ID（如果有的話）
- `channel`：指令發送的頻道
- `isAuthorizedSender`：發送者是否為授權使用者
- `args`：指令後傳入的參數（如果 `acceptsArgs: true`）
- `commandBody`：完整的指令文字
- `config`：目前的 OpenClaw 設定

指令選項：

- `name`：指令名稱（不含前導的 `/`）
- `nativeNames`：斜線／選單介面上的原生指令別名（可選）。使用 `default` 表示所有原生提供者，或使用特定提供者的鍵如 `discord`
- `description`：在指令列表中顯示的說明文字
- `acceptsArgs`：指令是否接受參數（預設：false）。若為 false 且有參數，指令將不匹配，訊息會繼續傳遞給其他處理器
- `requireAuth`：是否要求發送者為授權使用者（預設：true）
- `handler`：回傳 `{ text: string }` 的函式（可為非同步）

帶授權與參數的範例：

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

注意事項：

- 插件指令會在內建指令與 AI 代理之前處理
- 指令為全域註冊，適用於所有頻道
- 指令名稱不分大小寫（`/MyStatus` 與 `/mystatus` 視為相同）
- 指令名稱必須以字母開頭，且只能包含字母、數字、連字號與底線
- 保留指令名稱（如 `help`、`status`、`reset` 等）不可被插件覆寫
- 插件間重複註冊相同指令會失敗並產生診斷錯誤

### 註冊背景服務

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## 命名規範

- Gateway 方法：`pluginId.action`（範例：`voicecall.status`）
- 工具：`snake_case`（範例：`voice_call`）
- CLI 指令：使用 kebab 或 camel 命名，但避免與核心指令衝突

## 技能

插件可以在倉庫中提供一個技能 (`skills/<name>/SKILL.md`)。
透過 `plugins.entries.<id>.enabled`（或其他設定門檻）啟用，
並確保它存在於你的工作區/管理技能位置。

## 發行（npm）

建議的封裝方式：

- 主要套件：`openclaw`（此倉庫）
- 插件：在 `@openclaw/*` 底下的獨立 npm 套件（範例：`@openclaw/voice-call`）

發佈規範：

- 插件 `package.json` 必須包含 `openclaw.extensions`，且有一個或多個入口檔案。
- 入口檔案可以是 `.js` 或 `.ts`（jiti 在執行時載入 TS）。
- `openclaw plugins install <npm-spec>` 使用 `npm pack`，抽取到 `~/.openclaw/extensions/<id>/`，並在設定中啟用。
- 設定鍵的穩定性：範圍套件會被正規化為 **非範圍** ID 用於 `plugins.entries.*`。

## 範例插件：語音通話

此倉庫包含一個語音通話插件（Twilio 或日誌回退）：

- 原始碼：`extensions/voice-call`
- 技能：`skills/voice-call`
- CLI：`openclaw voicecall start|status`
- 工具：`voice_call`
- RPC：`voicecall.start`、`voicecall.status`
- 設定（twilio）：`provider: "twilio"` + `twilio.accountSid/authToken/from`（可選 `statusCallbackUrl`、`twimlUrl`）
- 設定（開發）：`provider: "log"`（無網路）

請參考 [語音通話](/plugins/voice-call) 及 `extensions/voice-call/README.md` 了解設定與使用方式。

## 安全注意事項

外掛程式與 Gateway 同進程執行。請將它們視為受信任的程式碼：

- 僅安裝你信任的外掛程式。
- 優先使用 `plugins.allow` 白名單。
- 變更後請重新啟動 Gateway。

## 測試外掛程式

外掛程式可以（且應該）附帶測試：

- 倉庫內的外掛程式可以將 Vitest 測試放在 `src/**` 下（範例：`src/plugins/voice-call.plugin.test.ts`）。
- 獨立發佈的外掛程式應該執行自己的 CI（lint/build/test），並驗證 `openclaw.extensions` 指向已建置的進入點 (`dist/index.js`)。
