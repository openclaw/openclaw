---
summary: "OpenClaw 插件/擴充功能：裝置探索、設定與安全"
read_when:
  - 新增或修改插件/擴充功能
  - 記錄插件安裝或載入規則
title: "Plugins"
---

# Plugins (擴充功能)

## 快速開始 (新手初試插件？)

插件只是一個**小型程式碼模組**，用於為 OpenClaw 擴充額外功能（指令、工具和 Gateway RPC）。

大多數情況下，當您想要使用尚未內建於 OpenClaw 核心的功能時（或者您想讓主安裝保持簡潔，將選用功能分開），就會使用插件。

快速路徑：

1. 查看已載入的內容：

```bash
openclaw plugins list
```

2. 安裝官方插件（例如：Voice Call）：

```bash
openclaw plugins install @openclaw/voice-call
```

3. 重啟 Gateway，然後在 `plugins.entries.<id>.config` 下進行設定。

請參閱 [Voice Call](/plugins/voice-call) 以了解具體的插件範例。

## 可用的插件 (官方)

- Microsoft Teams 自 2026.1.15 起僅提供插件版本；如果您使用 Teams，請安裝 `@openclaw/msteams`。
- 記憶體 (核心) — 隨附的記憶體搜尋插件（預設透過 `plugins.slots.memory` 啟用）
- 記憶體 (LanceDB) — 隨附的長期記憶體插件（自動回傳/擷取；請設定 `plugins.slots.memory = "memory-lancedb"`）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo 個人版](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (供應商驗證) — 內建為 `google-antigravity-auth`（預設禁用）
- Gemini CLI OAuth (供應商驗證) — 內建為 `google-gemini-cli-auth`（預設禁用）
- Qwen OAuth (供應商驗證) — 內建為 `qwen-portal-auth`（預設禁用）
- Copilot Proxy (供應商驗證) — 本地 VS Code Copilot Proxy 橋接；與內建的 `github-copilot` 裝置登入不同（內建，預設禁用）

OpenClaw 插件是透過 jiti 在執行階段載入的 **TypeScript 模組**。**設定驗證不會執行插件程式碼**；它會改用插件資訊清單 (manifest) 和 JSON Schema。請參閱 [Plugin manifest](/plugins/manifest)。

插件可以註冊：

- Gateway RPC 方法
- Gateway HTTP 處理常式 (handlers)
- 智慧代理工具 (Agent tools)
- CLI 指令
- 背景服務 (Background services)
- 選用設定驗證
- **Skills** (透過在插件資訊清單中列出 `skills` 目錄)
- **自動回覆指令** (無需調用 AI 智慧代理即可執行)

插件與 Gateway 在**同一個程序 (in-process)** 中執行，因此請將其視為受信任的程式碼。工具編寫指南：[Plugin agent tools](/plugins/agent-tools)。

## 執行階段輔助程式 (Runtime helpers)

插件可以透過 `api.runtime` 存取選定的核心輔助程式。對於電話 TTS：

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

注意事項：

- 使用核心 `messages.tts` 設定（OpenAI 或 ElevenLabs）。
- 傳回 PCM 音訊緩衝區 + 取樣率。插件必須為供應商重新取樣/編碼。
- 電話功能不支援 Edge TTS。

## 裝置探索與優先順序

OpenClaw 依序掃描：

1. 設定路徑

- `plugins.load.paths` (檔案或目錄)

2. 工作區擴充功能

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 全域擴充功能

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 內建擴充功能 (隨 OpenClaw 出貨，**預設禁用**)

- `<openclaw>/extensions/*`

內建插件必須透過 `plugins.entries.<id>.enabled` 或 `openclaw plugins enable <id>` 明確啟用。安裝的插件預設為啟用，但也可以用同樣的方式禁用。

每個插件的根目錄必須包含一個 `openclaw.plugin.json` 檔案。如果路徑指向一個檔案，則插件根目錄為該檔案所在的目錄，且該目錄必須包含資訊清單。

如果多個插件解析為相同的 ID，則依上述順序最先匹配到的插件勝出，較低優先順序的複本將被忽略。

### 封裝套件 (Package packs)

插件目錄可能包含帶有 `openclaw.extensions` 的 `package.json`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

每個項目都會成為一個插件。如果套件列出了多個擴充功能，插件 ID 將變為 `name/<fileBase>`。

如果您的插件需要匯入 npm 依賴項，請在該目錄中安裝它們，以便使用 `node_modules` (`npm install` / `pnpm install`)。

### 頻道目錄詮釋資料 (Channel catalog metadata)

頻道插件可以透過 `openclaw.channel` 提供新手導覽詮釋資料，並透過 `openclaw.install` 提供安裝提示。這能讓核心目錄不含特定資料。

範例：

```json
{
  "name": " @openclaw/nextcloud-talk",
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
      "npmSpec": " @openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw 還可以合併**外部頻道目錄**（例如 MPM 註冊表匯出）。請將 JSON 檔案放置於以下任一路徑：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或者將 `OPENCLAW_PLUGIN_CATALOG_PATHS`（或 `OPENCLAW_MPM_CATALOG_PATHS`）指向一個或多個 JSON 檔案（以逗號/分號/`PATH` 分隔符號分隔）。每個檔案應包含 `{ "entries": [ { "name": " @scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`。

## Plugin IDs

預設插件 ID：

- 封裝套件 (Package packs)：`package.json` 中的 `name`
- 獨立檔案：檔案基本名稱 (`~/.../voice-call.ts` → `voice-call`)

如果插件匯出了 `id`，OpenClaw 會使用它，但在與設定的 ID 不匹配時會發出警告。

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

欄位說明：

- `enabled`: 總開關（預設：true）
- `allow`: 允許清單（選填）
- `deny`: 拒絕清單（選填；拒絕清單優先級較高）
- `load.paths`: 額外的插件檔案/目錄
- `entries.<id>`: 各別插件的啟用開關 + 設定

設定變更**需要重啟 Gateway**。

驗證規則 (嚴格)：

- `entries`、`allow`、`deny` 或 `slots` 中未知的插件 ID 將視為**錯誤**。
- 除非插件資訊清單聲明了該頻道 ID，否則未知的 `channels.<id>` 鍵名將視為**錯誤**。
- 插件設定會使用 `openclaw.plugin.json` 中嵌入的 JSON Schema (`configSchema`) 進行驗證。
- 如果插件被禁用，其設定將被保留並發出**警告**。

## 插件插槽 (Plugin slots，互斥類別)

某些插件類別是**互斥的**（一次只能有一個處於作用中）。使用 `plugins.slots` 來選擇哪個插件擁有該插槽：

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 或設為 "none" 以禁用記憶體插件
    },
  },
}
```

如果多個插件聲明 `kind: "memory"`，則只有選定的插件會載入。其他插件將被禁用並顯示診斷資訊。

## 控制介面 (Control UI，Schema + 標籤)

Control UI 使用 `config.schema` (JSON Schema + `uiHints`) 來呈現更好的表單。

OpenClaw 會根據探索到的插件在執行階段增強 `uiHints`：

- 為 `plugins.entries.<id>` / `.enabled` / `.config` 新增各別插件的標籤
- 在以下路徑合併插件提供的選用設定欄位提示：
  `plugins.entries.<id>.config.<field>`

如果您希望插件的設定欄位顯示良好的標籤/佔位符（並將機密標記為敏感），請在插件資訊清單中隨 JSON Schema 提供 `uiHints`。

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
    "apiKey": { "label": "API 金鑰", "sensitive": true },
    "region": { "label": "地區", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # 將本地檔案/目錄複製到 ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # 支援相對路徑
openclaw plugins install ./plugin.tgz           # 從本地 tarball 安裝
openclaw plugins install ./plugin.zip           # 從本地 zip 安裝
openclaw plugins install -l ./extensions/voice-call # 連結 (不複製)，用於開發
openclaw plugins install @openclaw/voice-call # 從 npm 安裝
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` 僅適用於在 `plugins.installs` 下追蹤的 npm 安裝。

插件也可以註冊自己的頂層指令（例如：`openclaw voicecall`）。

## 插件 API (概覽)

插件匯出以下任一內容：

- 一個函數：`(api) => { ... }`
- 一個物件：`{ id, name, configSchema, register(api) { ... } }`

## 插件 Hook

插件可以隨附 Hook 並在執行階段註冊。這讓插件能綑綁事件驅動的自動化功能，而無需另外安裝 Hook 套件。

### 範例

```ts
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

注意事項：

- Hook 目錄遵循標準 Hook 結構 (`HOOK.md` + `handler.ts`)。
- Hook 適用規則依然有效（作業系統/二進位檔/環境變數/設定要求）。
- 插件管理的 Hook 會顯示在 `openclaw hooks list` 中，並標記為 `plugin:<id>`。
- 您無法透過 `openclaw hooks` 啟用/禁用插件管理的 Hook；請改為啟用/禁用該插件。

## 供應商插件 (模型驗證)

插件可以註冊**模型供應商驗證**流程，讓使用者可以在 OpenClaw 內執行 OAuth 或 API 金鑰設定（無需外部指令碼）。

透過 `api.registerProvider(...)` 註冊供應商。每個供應商公開一個或多個驗證方法（OAuth、API 金鑰、裝置代碼等）。這些方法支援：

- `openclaw models auth login --provider <id> [--method <id>]`

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
        // 執行 OAuth 流程並回傳驗證設定檔 (profiles)。
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
});
```

注意事項：

- `run` 接收一個 `ProviderAuthContext`，其中包含 `prompter`、`runtime`、`openUrl` 以及 `oauth.createVpsAwareHandlers` 輔助程式。
- 當您需要新增預設模型或供應商設定時，請傳回 `configPatch`。
- 傳回 `defaultModel` 以便 `--set-default` 可以更新智慧代理預設值。

### 註冊訊息頻道

插件可以註冊**頻道插件**，其行為就像內建頻道（WhatsApp、Telegram 等）。頻道設定位於 `channels.<id>` 下，並由您的頻道插件程式碼進行驗證。

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "示範頻道插件。",
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
```

注意事項：

- 將設定放在 `channels.<id>` 下（而非 `plugins.entries`）。
- `meta.label` 用於 CLI/UI 列表中的標籤。
- `meta.aliases` 新增別名 ID 用於標準化和 CLI 輸入。
- `meta.preferOver` 列出當兩者皆設定時要跳過自動啟用的頻道 ID。
- `meta.detailLabel` 和 `meta.systemImage` 讓 UI 顯示更豐富的頻道標籤/圖示。

### 編寫新的訊息頻道 (逐步指南)

當您想要一個**新的對話介面**（“訊息頻道”）而非模型供應商時，請使用此功能。模型供應商文件位於 `/providers/*`。

1. 挑選 ID 與設定結構

- 所有頻道設定皆位於 `channels.<id>` 下。
- 多帳號設定請優先使用 `channels.<id>.accounts.<accountId>`。

2. 定義頻道詮釋資料 (Metadata)

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` 控制 CLI/UI 列表。
- `meta.docsPath` 應指向文件頁面，例如 `/channels/<id>`。
- `meta.preferOver` 讓插件可以取代另一個頻道（自動啟用會優先選擇它）。
- `meta.detailLabel` 和 `meta.systemImage` 由 UI 用於詳細資訊文字/圖示。

3. 實作必要的轉接器 (Adapters)

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (對話類型、媒體、執行緒等)
- `outbound.deliveryMode` + `outbound.sendText` (用於基本傳送)

4. 根據需要新增選用轉接器

- `setup` (精靈)、`security` (私訊政策)、`status` (狀態/診斷)
- `gateway` (啟動/停止/登入)、`mentions`、`threading`、`streaming`
- `actions` (訊息操作)、`commands` (原生指令行為)

5. 在插件中註冊頻道

- `api.registerChannel({ plugin })`

最簡設定範例：

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

最簡頻道插件（僅限外傳）：

```ts
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
      // 在此將 `text` 傳送到您的頻道
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

載入插件（extensions 目錄或 `plugins.load.paths`），重啟 Gateway，然後在設定中配置 `channels.<id>`。

### 智慧代理工具 (Agent tools)

請參閱專用指南：[Plugin agent tools](/plugins/agent-tools)。

### 註冊 Gateway RPC 方法

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

插件可以註冊自訂的斜線指令，這些指令會 **在不調用 AI 智慧代理的情況下** 執行。這對於切換指令、狀態檢查或不需要 LLM 處理的快速操作非常有用。

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "顯示插件狀態",
    handler: (ctx) => ({
      text: `插件正在執行！頻道：${ctx.channel}`,
    }),
  });
}
```

指令處理常式上下文 (Context)：

- `senderId`: 傳送者 ID (如果可用)
- `channel`: 傳送指令的頻道
- `isAuthorizedSender`: 傳送者是否為經授權的使用者
- `args`: 指令後傳遞的參數 (如果 `acceptsArgs: true`)
- `commandBody`: 完整指令文字
- `config`: 當前的 OpenClaw 設定

指令選項：

- `name`: 指令名稱 (不含前導的 `/`)
- `description`: 指令列表中顯示的說明文字
- `acceptsArgs`: 指令是否接受參數 (預設：false)。如果為 false 且提供了參數，指令將不會匹配，訊息會交由其他處理常式處理
- `requireAuth`: 是否要求經授權的傳送者 (預設：true)
- `handler`: 回傳 `{ text: string }` 的函數 (可以是 async)

授權與參數範例：

```ts
api.registerCommand({
  name: "setmode",
  description: "設定插件模式",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `模式已設定為：${mode}` };
  },
});
```

注意事項：

- 插件指令會在內建指令和 AI 智慧代理**之前**處理
- 指令是全域註冊的，適用於所有頻道
- 指令名稱不區分大小寫 (`/MyStatus` 等同於 `/mystatus`)
- 指令名稱必須以字母開頭，且僅包含字母、數字、連字號和底線
- 保留指令名稱（如 `help`, `status`, `reset` 等）無法被插件覆蓋
- 不同插件之間的重複指令註冊將導致診斷錯誤並失敗

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

- Gateway 方法：`pluginId.action` (例如：`voicecall.status`)
- 工具：`snake_case` (例如：`voice_call`)
- CLI 指令：使用 kebab-case 或 camelCase，但應避免與核心指令衝突

## Skills

插件可以在儲存庫中隨附一個 Skill (`skills/<name>/SKILL.md`)。
使用 `plugins.entries.<id>.enabled` (或其他設定門檻) 啟用它，並確保它存在於您的工作區/託管的 Skills 路徑中。

## 發布 (npm)

建議的封裝方式：

- 主套件：`openclaw` (本儲存庫)
- 插件：在 `@openclaw/*` 範圍下的獨立 npm 套件 (例如：`@openclaw/voice-call`)

發布協定：

- 插件的 `package.json` 必須包含 `openclaw.extensions` 並指定一個或多個進入點檔案。
- 進入點檔案可以是 `.js` 或 `.ts` (jiti 會在執行階段載入 TS)。
- `openclaw plugins install <npm-spec>` 會使用 `npm pack`，將其解壓縮到 `~/.openclaw/extensions/<id>/` 並在設定中啟用。
- 設定鍵名穩定性：具範圍的套件名稱會被標準化為**不具範圍**的 ID，用於 `plugins.entries.*`。

## 插件範例：Voice Call

本儲存庫包含一個 Voice Call 插件 (Twilio 或 log 備援)：

- 原始碼：`extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- 工具：`voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- 設定 (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (選填 `statusCallbackUrl`, `twimlUrl`)
- 設定 (dev): `provider: "log"` (無網路)

請參閱 [Voice Call](/plugins/voice-call) 和 `extensions/voice-call/README.md` 以了解設定和用法。

## 安全注意事項

插件與 Gateway 在同一個程序中執行。請將其視為受信任的程式碼：

- 僅安裝您信任的插件。
- 優先使用 `plugins.allow` 允許清單。
- 變更後重啟 Gateway。

## 測試插件

插件可以（也應該）隨附測試：

- 儲存庫內的插件可以將 Vitest 測試放在 `src/**` 下（例如：`src/plugins/voice-call.plugin.test.ts`）。
- 獨立發布的插件應執行自己的 CI（lint/組建/測試），並驗證 `openclaw.extensions` 指向已組建的進入點 (`dist/index.js`)。
