---
summary: "OpenClaw 外掛/擴充功能：探索、設定及安全性"
read_when:
  - 新增或修改外掛/擴充功能
  - 文件化外掛安裝或載入規則
title: "外掛"
---

# 外掛 (擴充功能)

## 快速開始 (外掛新手？)

外掛只是一個**小型程式碼模組**，可透過額外功能 (命令、工具和 Gateway RPC) 擴充 OpenClaw。

大多數情況下，當您需要 OpenClaw 核心尚未內建的功能 (或您希望將選用功能排除在主要安裝之外) 時，就會使用外掛。

快速路徑：

1. 查看已載入的項目：

```bash
openclaw plugins list
```

2. 安裝官方外掛 (範例：Voice Call)：

```bash
openclaw plugins install @openclaw/voice-call
```

3. 重新啟動 Gateway，然後在 `plugins.entries.<id>.config` 下進行設定。

請參閱 [Voice Call](/plugins/voice-call) 以取得具體的外掛範例。

## 可用的外掛 (官方)

- Microsoft Teams 從 2026.1.15 開始僅限外掛；如果您使用 Teams，請安裝 `@openclaw/msteams`。
- Memory (Core) — 隨附的記憶體搜尋外掛 (透過 `plugins.slots.memory` 預設啟用)
- Memory (LanceDB) — 隨附的長期記憶體外掛 (自動回想/擷取；設定 `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — ` @openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — ` @openclaw/zalouser`
- [Matrix](/channels/matrix) — ` @openclaw/matrix`
- [Nostr](/channels/nostr) — ` @openclaw/nostr`
- [Zalo](/channels/zalo) — ` @openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — ` @openclaw/msteams`
- Google Antigravity OAuth (供應商驗證) — 隨附為 `google-antigravity-auth` (預設停用)
- Gemini CLI OAuth (供應商驗證) — 隨附為 `google-gemini-cli-auth` (預設停用)
- Qwen OAuth (供應商驗證) — 隨附為 `qwen-portal-auth` (預設停用)
- Copilot Proxy (供應商驗證) — 本機 VS Code Copilot Proxy 橋接；與內建的 `github-copilot` 裝置登入不同 (隨附，預設停用)

OpenClaw 外掛是**TypeScript 模組**，透過 jiti 在執行時載入。**設定驗證不執行外掛程式碼**；它改為使用外掛資訊清單和 JSON Schema。請參閱 [Plugin manifest](/plugins/manifest)。

外掛可以註冊：

- Gateway RPC 方法
- Gateway HTTP 處理常式
- 智慧代理工具
- CLI 命令
- 背景服務
- 選用設定驗證
- **Skills** (透過在外掛資訊清單中列出 `skills` 目錄)
- **自動回覆命令** (無需叫用 AI 智慧代理即可執行)

外掛與 Gateway **在處理程序內**執行，因此請將其視為受信任的程式碼。
工具撰寫指南：[Plugin agent tools](/plugins/agent-tools)。

## 執行時輔助工具

外掛可以透過 `api.runtime` 存取選定的核心輔助工具。對於電話 TTS：

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

注意事項：

- 使用核心 `messages.tts` 設定 (OpenAI 或 ElevenLabs)。
- 傳回 PCM 音訊緩衝區 + 取樣率。外掛必須為供應商重新取樣/編碼。
- 電話不支援 Edge TTS。

## 探索與優先順序

OpenClaw 依序掃描：

1. 設定路徑

- `plugins.load.paths` (檔案或目錄)

2. 工作區擴充功能

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 全域擴充功能

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. 隨附擴充功能 (OpenClaw 隨附，**預設停用**)

- `<openclaw>/extensions/*`

隨附外掛必須透過 `plugins.entries.<id>.enabled` 或 `openclaw plugins enable <id>` 明確啟用。已安裝的外掛預設為啟用，但可以透過相同方式停用。

每個外掛都必須在其根目錄中包含一個 `openclaw.plugin.json` 檔案。如果路徑指向檔案，則外掛根目錄是該檔案的目錄，並且必須包含資訊清單。

如果多個外掛解析為相同的 ID，則依上述順序中的第一個相符項獲勝，並忽略優先順序較低的副本。

### 套件包

外掛目錄可能包含一個帶有 `openclaw.extensions` 的 `package.json`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

每個條目都成為一個外掛。如果套件列出多個擴充功能，則外掛 ID 變為 `name/<fileBase>`。

如果您的外掛導入 npm 依賴項，請將它們安裝到該目錄中，以便 `node_modules` 可用 (`npm install` / `pnpm install`)。

### 頻道目錄中繼資料

頻道外掛可以透過 `openclaw.channel` 宣傳新手導覽中繼資料，並透過 `openclaw.install` 宣傳安裝提示。這使得核心目錄無資料。

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
      "blurb": "透過 Nextcloud Talk webhook 機器人進行自託管聊天。",
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

OpenClaw 也可以合併**外部頻道目錄** (例如，MPM 登錄檔匯出)。在以下位置之一放置 JSON 檔案：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或將 `OPENCLAW_PLUGIN_CATALOG_PATHS` (或 `OPENCLAW_MPM_CATALOG_PATHS`) 指向一個或多個 JSON 檔案 (以逗號/分號/`PATH` 分隔)。每個檔案應包含 `{ "entries": [ { "name": " @scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`。

## 外掛 ID

預設外掛 ID：

- 套件包：`package.json` `name`
- 獨立檔案：檔案基本名稱 (`~/.../voice-call.ts` → `voice-call`)

如果外掛匯出 `id`，OpenClaw 將使用它，但在它與已設定的 ID 不符時發出警告。

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

- `enabled`：主切換 (預設：true)
- `allow`：允許清單 (選用)
- `deny`：拒絕清單 (選用；拒絕優先)
- `load.paths`：額外的外掛檔案/目錄
- `entries.<id>`：每個外掛的切換 + 設定

設定變更**需要重新啟動 Gateway**。

驗證規則 (嚴格)：

- `entries`、`allow`、`deny` 或 `slots` 中的未知外掛 ID 會導致**錯誤**。
- 未知的 `channels.<id>` 鍵會導致**錯誤**，除非外掛資訊清單聲明了該頻道 ID。
- 外掛設定使用嵌入在 `openclaw.plugin.json` 中的 JSON Schema (`configSchema`) 進行驗證。
- 如果外掛被停用，其設定會被保留並發出**警告**。

## 外掛插槽 (獨佔類別)

某些外掛類別是**獨佔的** (一次只有一個啟用)。使用 `plugins.slots` 來選擇哪個外掛擁有該插槽：

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // 或 "none" 停用記憶體外掛
    },
  },
}
```

如果多個外掛宣告 `kind: "memory"`，則只有選定的外掛會載入。其他外掛將被停用並顯示診斷訊息。

## 控制使用者介面 (schema + 標籤)

控制使用者介面使用 `config.schema` (JSON Schema + `uiHints`) 來呈現更好的表單。

OpenClaw 根據發現的外掛在執行時擴充 `uiHints`：

- 為 `plugins.entries.<id>` / `.enabled` / `.config` 新增每個外掛的標籤
- 合併在 `plugins.entries.<id>.config.<field>` 下外掛提供的選用設定欄位提示

如果您希望外掛設定欄位顯示良好的標籤/佔位符 (並將機密標記為敏感)，請在外掛資訊清單中與 JSON Schema 一起提供 `uiHints`。

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
openclaw plugins install <path>                 # 將本機檔案/目錄複製到 ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # 允許相對路徑
openclaw plugins install ./plugin.tgz           # 從本機 tarball 安裝
openclaw plugins install ./plugin.zip           # 從本機 zip 安裝
openclaw plugins install -l ./extensions/voice-call # 開發用途的連結 (不複製)
openclaw plugins install @openclaw/voice-call # 從 npm 安裝
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` 僅適用於 `plugins.installs` 下追蹤的 npm 安裝。

外掛也可以註冊自己的頂層命令 (範例：`openclaw voicecall`)。

## 外掛 API (概覽)

外掛匯出：

- 一個函式：`(api) => { ... }`
- 一個物件：`{ id, name, configSchema, register(api) { ... } }`

## 外掛掛鉤

外掛可以隨附掛鉤並在執行時註冊。這讓外掛可以捆綁事件驅動的自動化，而無需單獨安裝掛鉤包。

### 範例

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

注意事項：

- 掛鉤目錄遵循正常的掛鉤結構 (`HOOK.md` + `handler.ts`)。
- 掛鉤資格規則仍然適用 (OS/bins/env/config 要求)。
- 外掛管理的掛鉤會以 `plugin:<id>` 顯示在 `openclaw hooks list` 中。
- 您無法透過 `openclaw hooks` 啟用/停用外掛管理的掛鉤；請改為啟用/停用外掛。

## 供應商外掛 (模型驗證)

外掛可以註冊**模型供應商驗證**流程，以便使用者可以在 OpenClaw 內部執行 OAuth 或 API 金鑰設定 (無需外部腳本)。

透過 `api.registerProvider(...)` 註冊供應商。每個供應商都會公開一個或多個驗證方法 (OAuth、API 金鑰、裝置代碼等)。這些方法驅動：

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
        // 執行 OAuth 流程並傳回驗證設定檔。
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

- `run` 接收帶有 `prompter`、`runtime`、`openUrl` 和 `oauth.createVpsAwareHandlers` 輔助工具的 `ProviderAuthContext`。
- 當您需要新增預設模型或供應商設定時，傳回 `configPatch`。
- 傳回 `defaultModel`，以便 `--set-default` 可以更新智慧代理預設值。

### 註冊訊息頻道

外掛可以註冊行為類似內建頻道 (WhatsApp、Telegram 等) 的**頻道外掛**。頻道設定位於 `channels.<id>` 下，並由您的頻道外掛程式碼進行驗證。

```ts
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
```

注意事項：

- 將設定放在 `channels.<id>` 下 (而不是 `plugins.entries`)。
- `meta.label` 用於 CLI/UI 清單中的標籤。
- `meta.aliases` 為正規化和 CLI 輸入新增替代 ID。
- `meta.preferOver` 列出當兩者都已設定時要跳過自動啟用的頻道 ID。
- `meta.detailLabel` 和 `meta.systemImage` 讓 UI 顯示更豐富的頻道標籤/圖示。

### 編寫新的訊息頻道 (逐步)

當您想要**新的聊天介面** (一個「訊息頻道」)，而不是模型供應商時，請使用此功能。
模型供應商文件位於 `/providers/*` 下。

1. 選擇 ID + 設定形狀

- 所有頻道設定都位於 `channels.<id>` 下。
- 多帳戶設定建議使用 `channels.<id>.accounts.<accountId>`。

2. 定義頻道中繼資料

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` 控制 CLI/UI 清單。
- `meta.docsPath` 應指向像 `/channels/<id>` 這樣的文件頁面。
- `meta.preferOver` 允許外掛替換另一個頻道 (自動啟用會優先選擇它)。
- `meta.detailLabel` 和 `meta.systemImage` 用於 UI 中的詳細資訊文字/圖示。

3. 實作所需的轉接器

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (聊天類型、媒體、執行緒等)
- `outbound.deliveryMode` + `outbound.sendText` (用於基本傳送)

4. 視需要新增選用轉接器

- `setup` (精靈)、`security` (DM 政策)、`status` (健康/診斷)
- `gateway` (啟動/停止/登入)、`mentions`、`threading`、`streaming`
- `actions` (訊息動作)、`commands` (原生命令行為)

5. 在您的外掛中註冊頻道

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

最簡頻道外掛 (僅限出站)：

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
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
      // 在此將 `text` 傳遞到您的頻道
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

載入外掛 (擴充功能目錄或 `plugins.load.paths`)，重新啟動 Gateway，然後在您的設定中設定 `channels.<id>`。

### 智慧代理工具

請參閱專用指南：[Plugin agent tools](/plugins/agent-tools)。

### 註冊 Gateway RPC 方法

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### 註冊 CLI 命令

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

### 註冊自動回覆命令

外掛可以註冊自訂斜線命令，這些命令**無需叫用 AI 智慧代理**即可執行。這對於切換命令、狀態檢查或不需要 LLM 處理的快速動作很有用。

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

命令處理常式上下文：

- `senderId`：傳送者的 ID (如果可用)
- `channel`：傳送命令的頻道
- `isAuthorizedSender`：傳送者是否為授權使用者
- `args`：命令後傳遞的參數 (如果 `acceptsArgs: true`)
- `commandBody`：完整的命令文字
- `config`：目前的 OpenClaw 設定

命令選項：

- `name`：命令名稱 (不帶前導 `/`)
- `description`：命令清單中顯示的說明文字
- `acceptsArgs`：命令是否接受參數 (預設：false)。如果為 false 且提供了參數，則命令將不匹配，訊息會傳遞給其他處理常式
- `requireAuth`：是否需要授權傳送者 (預設：true)
- `handler`：傳回 `{ text: string }` 的函式 (可以是非同步)

帶有授權和參數的範例：

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

- 外掛命令在內建命令和 AI 智慧代理**之前**處理
- 命令是全域註冊的，並適用於所有頻道
- 命令名稱不區分大小寫 (`/MyStatus` 匹配 `/mystatus`)
- 命令名稱必須以字母開頭，並且只能包含字母、數字、連字號和底線
- 保留的命令名稱 (例如 `help`、`status`、`reset` 等) 不能被外掛覆蓋
- 外掛之間重複註冊命令將導致診斷錯誤

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

## 命名慣例

- Gateway 方法：`pluginId.action` (範例：`voicecall.status`)
- 工具：`snake_case` (範例：`voice_call`)
- CLI 命令：kebab 或 camel，但避免與核心命令衝突

## Skills

外掛可以在儲存庫中隨附一個 skill (`skills/<name>/SKILL.md`)。
透過 `plugins.entries.<id>.enabled` (或其他設定閘道) 啟用它，並確保它存在於您的工作區/管理 skills 位置。

## 分發 (npm)

建議的封裝：

- 主要套件：`openclaw` (此儲存庫)
- 外掛：` @openclaw/*` 下的獨立 npm 套件 (範例：` @openclaw/voice-call`)

發佈契約：

- 外掛 `package.json` 必須包含帶有一個或多個入口檔案的 `openclaw.extensions`。
- 入口檔案可以是 `.js` 或 `.ts` (jiti 在執行時載入 TS)。
- `openclaw plugins install <npm-spec>` 使用 `npm pack`，解壓縮到 `~/.openclaw/extensions/<id>/`，並在設定中啟用它。
- 設定鍵穩定性：作用域套件會正規化為 `plugins.entries.*` 的**無作用域** ID。

## 範例外掛：Voice Call

此儲存庫包含一個語音通話外掛 (Twilio 或日誌回退)：

- 原始碼：`extensions/voice-call`
- Skill：`skills/voice-call`
- CLI：`openclaw voicecall start|status`
- 工具：`voice_call`
- RPC：`voicecall.start`、`voicecall.status`
- 設定 (twilio)：`provider: "twilio"` + `twilio.accountSid/authToken/from` (選用 `statusCallbackUrl`、`twimlUrl`)
- 設定 (dev)：`provider: "log"` (無網路)

請參閱 [Voice Call](/plugins/voice-call) 和 `extensions/voice-call/README.md` 以取得設定和使用方式。

## 安全注意事項

外掛與 Gateway 在處理程序內執行。請將它們視為受信任的程式碼：

- 僅安裝您信任的外掛。
- 偏好 `plugins.allow` 允許清單。
- 變更後重新啟動 Gateway。

## 測試外掛

外掛可以 (也應該) 隨附測試：

- 儲存庫內外掛可以在 `src/**` 下保留 Vitest 測試 (範例：`src/plugins/voice-call.plugin.test.ts`)。
- 單獨發佈的外掛應執行自己的 CI (lint/build/test) 並驗證 `openclaw.extensions` 指向已建置的入口點 (`dist/index.js`)。
