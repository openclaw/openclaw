---
summary: "OpenClaw 外掛／擴充：探索、設定與安全性"
read_when:
  - 新增或修改外掛／擴充
  - 文件化外掛安裝或載入規則
title: "Plugins"
---

# 外掛（Extensions）

## Quick start (new to plugins?)

A plugin is just a **small code module** that extends OpenClaw with extra
features (commands, tools, and Gateway RPC).

大多數情況下，當你需要一個尚未內建於核心 OpenClaw 的功能（或想把可選功能從主要安裝中分離）時，就會使用外掛。

快速路徑：

1. See what’s already loaded:

```bash
openclaw plugins list
```

2. 安裝官方外掛（範例：Voice Call）：

```bash
openclaw plugins install @openclaw/voice-call
```

3. 重新啟動 Gateway，然後在 `plugins.entries.<id>.config` 下進行設定。

請參考 [Voice Call](/plugins/voice-call) 作為具體的外掛範例。

## Available plugins (official)

- Microsoft Teams 自 2026.1.15 起僅能透過外掛使用；若你使用 Teams，請安裝 `@openclaw/msteams`。
- Memory（Core）— 隨附的記憶體搜尋外掛（預設透過 `plugins.slots.memory` 啟用）
- Memory（LanceDB）— 隨附的長期記憶體外掛（自動回憶／擷取；設定 `plugins.slots.memory = "memory-lancedb"`）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth（提供者身分驗證）— 隨附為 `google-antigravity-auth`（預設停用）
- Gemini CLI OAuth（提供者身分驗證）— 隨附為 `google-gemini-cli-auth`（預設停用）
- Qwen OAuth（提供者身分驗證）— 隨附為 `qwen-portal-auth`（預設停用）
- Copilot Proxy（提供者身分驗證）— 本地 VS Code Copilot Proxy 橋接；不同於內建的 `github-copilot` 裝置登入（隨附，預設停用）

OpenClaw 外掛是 **TypeScript 模組**，在執行時透過 jiti 載入。**設定驗證不會執行外掛程式碼**；而是使用外掛資訊清單與 JSON Schema。請參閱 [Plugin manifest](/plugins/manifest)。 **Config
validation does not execute plugin code**; it uses the plugin manifest and JSON
Schema instead. See [Plugin manifest](/plugins/manifest).

Plugins can register:

- Gateway RPC 方法
- Gateway HTTP 處理器
- 代理程式工具
- CLI 指令
- 背景服務
- 可選的設定驗證
- **Skills**（在外掛資訊清單中列出 `skills` 目錄）
- **自動回覆指令**（在不呼叫 AI 代理程式的情況下執行）

外掛 **與 Gateway 同一行程中執行**，因此請將其視為受信任的程式碼。
工具撰寫指南：[Plugin agent tools](/plugins/agent-tools)。
Tool authoring guide: [Plugin agent tools](/plugins/agent-tools).

## 執行期輔助工具

Plugins can access selected core helpers via `api.runtime`. For telephony TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

注意事項：

- 使用核心 `messages.tts` 設定（OpenAI 或 ElevenLabs）。
- 45. 回傳 PCM 音訊緩衝區 + 取樣率。 Plugins must resample/encode for providers.
- 電話語音不支援 Edge TTS。

## 探索與優先順序

OpenClaw 會依序掃描：

1. 設定路徑

- `plugins.load.paths`（檔案或目錄）

2. 工作區擴充

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. 全域擴充

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Bundled extensions (shipped with OpenClaw, **disabled by default**)

- `<openclaw>/extensions/*`

隨附外掛必須透過 `plugins.entries.<id>.enabled`
或 `openclaw plugins enable <id>` 明確啟用。已安裝的外掛預設為啟用，
但也可以用相同方式停用。 Installed plugins are enabled by default,
but can be disabled the same way.

每個外掛都必須在其根目錄包含一個 `openclaw.plugin.json` 檔案。若路徑指向單一檔案，外掛根目錄即為該檔案所在目錄，且必須包含該資訊清單。 If a path
points at a file, the plugin root is the file's directory and must contain the
manifest.

如果多個外掛解析為相同的 id，以上述順序中最先符合者為準，較低優先順序的副本會被忽略。

### 套件包（Package packs）

外掛目錄可以包含一個 `package.json`，其中列出 `openclaw.extensions`：

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

如果你的外掛匯入了 npm 相依套件，請在該目錄中安裝它們，以確保 `node_modules` 可用（`npm install` / `pnpm install`）。

### 46. 頻道目錄中繼資料

47. 頻道外掛可透過 `openclaw.channel` 宣告新手導覽中繼資料，並透過 `openclaw.install` 提供安裝提示。 This keeps the core catalog data-free.

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

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). 48. 在以下其中一個位置放置 JSON 檔案：

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

或將 `OPENCLAW_PLUGIN_CATALOG_PATHS`（或 `OPENCLAW_MPM_CATALOG_PATHS`）指向一個或多個 JSON 檔案（以逗號／分號／`PATH` 分隔）。每個檔案都應包含 `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }\`。

## Plugin IDs

49. 預設外掛 ID：

- 套件包：`package.json` `name`
- 獨立檔案：檔名（不含副檔名）（`~/.../voice-call.ts` → `voice-call`）

如果外掛匯出 `id`，OpenClaw 會使用它，但當其與設定的 id 不一致時會發出警告。

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
- `allow`：允許清單（選用）
- `deny`: denylist (optional; deny wins)
- `load.paths`：額外的外掛檔案／目錄
- `entries.<id>`：每個外掛的開關與設定

設定變更 **需要重新啟動 Gateway**。

驗證規則（嚴格）：

- 在 `entries`、`allow`、`deny` 或 `slots` 中出現未知的外掛 id 會被視為 **錯誤**。
- 未知的 `channels.<id>` 金鑰會被視為 **錯誤**，除非外掛資訊清單宣告了該頻道 id。
- 外掛設定會使用內嵌於 `openclaw.plugin.json`（`configSchema`）中的 JSON Schema 進行驗證。
- If a plugin is disabled, its config is preserved and a **warning** is emitted.

## 50. 外掛插槽（互斥類別）

Some plugin categories are **exclusive** (only one active at a time). Use
`plugins.slots` to select which plugin owns the slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

If multiple plugins declare `kind: "memory"`, only the selected one loads. Others
are disabled with diagnostics.

## 控制介面（Schema + 標籤）

控制介面使用 `config.schema`（JSON Schema + `uiHints`）來呈現更好的表單。

OpenClaw 會在執行期根據已探索到的外掛擴充 `uiHints`：

- 為 `plugins.entries.<id>`／`.enabled`／`.config` 新增各外掛的標籤
- 合併外掛提供的可選設定欄位提示至：
  `plugins.entries.<id>.config.<field>`

若你希望外掛設定欄位顯示良好的標籤／提示（並將祕密標示為敏感），請在外掛資訊清單中，與 JSON Schema 一同提供 `uiHints`。

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
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` 僅適用於在 `plugins.installs` 下追蹤的 npm 安裝。

外掛也可以註冊自己的頂層指令（例如：`openclaw voicecall`）。

## 外掛 API（概覽）

Plugins export either:

- 函式：`(api) => { ... }`
- 物件：`{ id, name, configSchema, register(api) { ... } }`

## Plugin hooks

外掛可以隨附 hooks 並在執行時註冊它們。 This lets a plugin bundle
event-driven automation without a separate hook pack install.

### 範例

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

注意事項：

- Hook 目錄遵循一般 Hook 結構（`HOOK.md` + `handler.ts`）。
- Hook 的適用規則仍然適用（作業系統／二進位檔／環境變數／設定需求）。
- 由外掛管理的 Hook 會顯示在 `openclaw hooks list` 中，並標示為 `plugin:<id>`。
- 你無法透過 `openclaw hooks` 啟用/停用由外掛管理的 hooks；請改為啟用/停用該外掛。

## 提供者外掛（模型身分驗證）

外掛可以註冊 **模型提供者身分驗證** 流程，讓使用者能在 OpenClaw 內完成 OAuth 或 API 金鑰設定（無需外部腳本）。

透過 `api.registerProvider(...)` 註冊提供者。每個提供者會公開一或多種驗證方式（OAuth、API 金鑰、裝置碼等）。這些方式支援： 每個提供者會暴露一種
或多種驗證方式（OAuth、API 金鑰、裝置代碼等）。 These methods power:

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
});
```

注意事項：

- `run` 會收到一個 `ProviderAuthContext`，其中包含 `prompter`、`runtime`、
  `openUrl` 與 `oauth.createVpsAwareHandlers` 輔助工具。
- 當你需要加入預設模型或提供者設定時，回傳 `configPatch`。
- 回傳 `defaultModel`，讓 `--set-default` 能更新代理程式預設值。

### 註冊一個訊息通道

外掛可以註冊**通道外掛**，其行為就像內建通道
（WhatsApp、Telegram 等）。 通道設定位於 `channels.<id>` and is
validated by your channel plugin code.

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

- 將設定放在 `channels.<id>`（而非 `plugins.entries`）。
- `meta.label` 用於 CLI／UI 清單中的標籤。
- `meta.aliases` 新增替代 id 以利正規化與 CLI 輸入。
- `meta.preferOver` 列出在同時設定時要略過自動啟用的頻道 id。
- `meta.detailLabel` 與 `meta.systemImage` 可讓 UI 顯示更豐富的頻道標籤／圖示。

### 撰寫新的訊息頻道（逐步說明）

當你需要 **新的聊天介面**（「訊息頻道」）而非模型提供者時，請使用本節。
模型提供者文件位於 `/providers/*`。
模型提供者文件位於 `/providers/*`。

1. 選擇一個 id 與設定結構

- 所有頻道設定都位於 `channels.<id>` 下。
- 多帳號情境建議使用 `channels.<id>.accounts.<accountId>`。

2. 定義頻道中繼資料

- `meta.label`、`meta.selectionLabel`、`meta.docsPath`、`meta.blurb` 控制 CLI／UI 清單。
- `meta.docsPath` 應指向如 `/channels/<id>` 的文件頁面。
- `meta.preferOver` 允許外掛取代另一個頻道（自動啟用時優先）。
- `meta.detailLabel` 與 `meta.systemImage` 供 UI 顯示詳細文字／圖示。

3. 實作必要的轉接器

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities`（聊天類型、媒體、執行緒等）
- `outbound.deliveryMode` + `outbound.sendText`（基本傳送）

4. 視需要加入可選轉接器

- `setup`（精靈）、`security`（私訊政策）、`status`（健康狀態／診斷）
- `gateway`（啟動／停止／登入）、`mentions`、`threading`、`streaming`
- `actions`（訊息動作）、`commands`（原生命令行為）

5. 在你的外掛中註冊該通道

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

最小頻道外掛（僅輸出）：

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
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

載入外掛（extensions 目錄或 `plugins.load.paths`），重新啟動 Gateway，
然後在設定中配置 `channels.<id>`。

### 代理程式工具

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

外掛可以註冊自訂斜線指令，且在執行時**不會呼叫 AI 代理**。 這對於切換指令、狀態檢查，或不需要 LLM 處理的快速操作很有用。

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

指令處理器內容：

- `senderId`：寄件者的 ID（若可取得）
- `channel`：指令送出的頻道
- `isAuthorizedSender`：寄件者是否為已授權使用者
- `args`：指令後的參數（若 `acceptsArgs: true`）
- `commandBody`：完整指令文字
- `config`：目前的 OpenClaw 設定

指令選項：

- `name`：指令名稱（不含前導的 `/`）
- `description`：顯示於指令清單中的說明文字
- `acceptsArgs`：是否接受參數（預設：false）。若為 false 且提供了參數，指令將不會匹配，訊息會交由其他處理器 If false and arguments are provided, the command won't match and the message falls through to other handlers
- `requireAuth`：是否要求已授權寄件者（預設：true）
- `handler`：回傳 `{ text: string }` 的函式（可為 async）

包含授權與參數的範例：

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

- 外掛指令會在**內建指令與 AI 代理**之前處理
- 指令為全域註冊，並可在所有頻道中使用
- 指令名稱不分大小寫（`/MyStatus` 會匹配 `/mystatus`）
- 指令名稱必須以字母開頭，且僅能包含字母、數字、連字號與底線
- 保留指令名稱（如 `help`、`status`、`reset` 等）不可被外掛覆寫 且不能被外掛覆寫
- 跨外掛重複註冊相同指令將會失敗，並顯示診斷錯誤

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

- Gateway 方法：`pluginId.action`（範例：`voicecall.status`）
- 工具：`snake_case`（範例：`voice_call`）
- CLI 指令：kebab 或 camel 皆可，但請避免與核心指令衝突

## Skills

Plugins can ship a skill in the repo (`skills/<name>/SKILL.md`).
Enable it with `plugins.entries.<id>.enabled`（或其他設定閘門）啟用，並確保
其存在於你的工作區／受管 skills 位置中。

## 發佈（npm）

建議的封裝方式：

- 主套件：`openclaw`（本儲存庫）
- 外掛：獨立的 npm 套件，位於 `@openclaw/*` 之下（範例：`@openclaw/voice-call`）

發佈合約：

- 外掛的 `package.json` 必須包含 `openclaw.extensions`，並列出一或多個進入點檔案。
- 進入點檔案可為 `.js` 或 `.ts`（jiti 會在執行期載入 TS）。
- `openclaw plugins install <npm-spec>` 使用 `npm pack`，解壓至 `~/.openclaw/extensions/<id>/`，並在設定中啟用。
- 設定鍵穩定性：具 scope 的套件會正規化為 **無 scope** 的 id 以用於 `plugins.entries.*`。

## 範例外掛：Voice Call

本儲存庫包含一個語音通話外掛（Twilio 或記錄回退）：

- 原始碼：`extensions/voice-call`
- Skill：`skills/voice-call`
- CLI：`openclaw voicecall start|status`
- 工具：`voice_call`
- RPC：`voicecall.start`、`voicecall.status`
- 設定（twilio）：`provider: "twilio"` + `twilio.accountSid/authToken/from`（選用 `statusCallbackUrl`、`twimlUrl`）
- 設定（dev）：`provider: "log"`（無網路）

請參閱 [Voice Call](/plugins/voice-call) 與 `extensions/voice-call/README.md` 了解設定與使用方式。

## 安全性注意事項

Plugins run in-process with the Gateway. 請將它們視為受信任的程式碼：

- Only install plugins you trust.
- 優先使用 `plugins.allow` 允許清單。
- 變更後請重新啟動 Gateway。

## 測試外掛

Plugins can (and should) ship tests:

- 儲存庫內的外掛可在 `src/**` 下放置 Vitest 測試（範例：`src/plugins/voice-call.plugin.test.ts`）。
- 獨立發佈的外掛應執行自己的 CI（lint／build／test），並驗證 `openclaw.extensions` 指向已建置的進入點（`dist/index.js`）。
