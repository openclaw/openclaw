---
summary: >-
  Configuration overview: common tasks, quick setup, and links to the full
  reference
read_when:
  - Setting up OpenClaw for the first time
  - Looking for common configuration patterns
  - Navigating to specific config sections
title: Configuration
---

# Configuration

OpenClaw 從 `~/.openclaw/openclaw.json` 讀取可選的 <Tooltip tip="JSON5 支援註解和尾隨逗號">**JSON5**</Tooltip> 設定。

如果檔案遺失，OpenClaw 會使用安全的預設值。添加設定的常見原因：

- 連接通道並控制誰可以發送訊息給機器人
- 設定模型、工具、沙盒或自動化（排程、鉤子）
- 調整會話、媒體、網路或使用者介面

請參閱 [full reference](/gateway/configuration-reference) 以獲取所有可用欄位的詳細資訊。

<Tip>
**對設定不熟悉嗎？** 可以從 `openclaw onboard` 開始進行互動式設置，或查看 [設定範例](/gateway/configuration-examples) 指南以獲取完整的複製粘貼設定。
</Tip>

## Minimal config

```json5
// ~/.openclaw/openclaw.json
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

## 編輯設定

<Tabs>
  <Tab title="互動式精靈">
    ```bash
    openclaw onboard       # full setup wizard
    openclaw configure     # config wizard
    ```
  </Tab>
  <Tab title="CLI（單行指令）">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="控制介面">
    開啟 [http://127.0.0.1:18789](http://127.0.0.1:18789) 並使用 **Config** 標籤。
    控制介面根據設定架構渲染一個表單，並提供 **Raw JSON** 編輯器作為備用選項。
  </Tab>
  <Tab title="直接編輯">
    直接編輯 `~/.openclaw/openclaw.json`。Gateway 會監控該檔案並自動應用變更（請參見 [hot reload](#config-hot-reload)）。
  </Tab>
</Tabs>

## 嚴格驗證

<Warning>
OpenClaw 只接受完全符合架構的設定。未知的鍵、格式錯誤的類型或無效的值會導致 Gateway **拒絕啟動**。唯一的根級例外是 `$schema` (字串)，因此編輯器可以附加 JSON Schema 元數據。
</Warning>

當驗證失敗時：

- 閘道器無法啟動
- 只有診斷命令可以運作 (`openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`)
- 執行 `openclaw doctor` 以查看具體問題
- 執行 `openclaw doctor --fix` (或 `--yes`) 以進行修復

## 常見任務

<AccordionGroup>
  <Accordion title="設定頻道（WhatsApp、Telegram、Discord 等）">
    每個頻道在 `channels.<provider>` 下都有自己的設定區域。請參閱專用的頻道頁面以獲取設定步驟：

- [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
  - [Telegram](/channels/telegram) — `channels.telegram`
  - [Discord](/channels/discord) — `channels.discord`
  - [Slack](/channels/slack) — `channels.slack`
  - [Signal](/channels/signal) — `channels.signal`
  - [iMessage](/channels/imessage) — `channels.imessage`
  - [Google Chat](/channels/googlechat) — `channels.googlechat`
  - [Mattermost](/channels/mattermost) — `channels.mattermost`
  - [MS Teams](/channels/msteams) — `channels.msteams`

所有頻道共享相同的 DM 政策模式：

````json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // only for allowlist/open
        },
      },
    }
    ```

</Accordion>

<Accordion title="選擇和設定模型">
    設定主要模型和可選的備用模型：

```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
            "openai/gpt-5.2": { alias: "GPT" },
          },
        },
      },
    }
    ```

- `agents.defaults.models` 定義了模型目錄並作為 `/model` 的允許清單。
    - 模型引用使用 `provider/model` 格式（例如 `anthropic/claude-opus-4-6`）。
    - `agents.defaults.imageMaxDimensionPx` 控制文字記錄/工具圖像的縮小（預設值 `1200`）；較低的值通常會減少在截圖密集的執行中對視覺 token 的使用。
    - 請參閱 [Models CLI](/concepts/models) 以在聊天中切換模型，以及 [Model Failover](/concepts/model-failover) 以了解身份驗證輪換和回退行為。
    - 有關自訂/自我託管提供者，請參閱參考中的 [Custom providers](/gateway/configuration-reference#custom-providers-and-base-urls)。

</Accordion>

<Accordion title="控制誰可以發送訊息給機器人">
    DM 存取權限是透過 `dmPolicy` 來控制每個頻道的：

- `"pairing"` (預設): 不明發件人會獲得一次性配對碼以進行批准
    - `"allowlist"`: 只有 `allowFrom` 中的發件人 (或配對的允許商店)
    - `"open"`: 允許所有進入的私訊 (需要 `allowFrom: ["*"]`)
    - `"disabled"`: 忽略所有私訊

對於群組，使用 `groupPolicy` + `groupAllowFrom` 或特定頻道的允許清單。

請參閱 [full reference](/gateway/configuration-reference#dm-and-group-access) 以獲取每個頻道的詳細資訊。

</Accordion>

<Accordion title="設定群組聊天提及限制">
    群組訊息預設為 **需要提及**。為每個代理設定模式：

```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: ["@openclaw", "openclaw"],
            },
          },
        ],
      },
      channels: {
        whatsapp: {
          groups: { "*": { requireMention: true } },
        },
      },
    }
    ```

- **元資料提及**：原生 @-提及（WhatsApp 點擊提及、Telegram @bot 等）
    - **文字模式**：在 `mentionPatterns` 中的正則表達式模式
    - 參見 [完整參考](/gateway/configuration-reference#group-chat-mention-gating) 以獲取每個通道的覆蓋和自我聊天模式。

</Accordion>

<Accordion title="設定會話和重置">
    會話控制對話的連續性和隔離性：

```json5
    {
      session: {
        dmScope: "per-channel-peer",  // recommended for multi-user
        threadBindings: {
          enabled: true,
          idleHours: 24,
          maxAgeHours: 0,
        },
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

- `dmScope`: `main` (共享) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - `threadBindings`: 用於線程綁定會話路由的全域預設值（Discord 支援 `/focus`、`/unfocus`、`/agents`、`/session idle` 和 `/session max-age`）。
    - 請參閱 [會話管理](/concepts/session) 以了解範圍、身份連結和發送政策。
    - 請參閱 [完整參考](/gateway/configuration-reference#session) 以獲取所有欄位。

</Accordion>

<Accordion title="啟用沙盒模式">
    在隔離的 Docker 容器中執行代理會話：

```json5
    {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",  // off | non-main | all
            scope: "agent",    // session | agent | shared
          },
        },
      },
    }
    ```

首先建立映像檔：`scripts/sandbox-setup.sh`

請參閱 [Sandboxing](/gateway/sandboxing) 以獲取完整指南，以及 [full reference](/gateway/configuration-reference#sandbox) 以了解所有選項。

</Accordion>

<Accordion title="啟用官方 iOS 版本的中繼推播">
    中繼推播的設定在 `openclaw.json`。

在閘道設定中設置這個：

```json5
    {
      gateway: {
        push: {
          apns: {
            relay: {
              baseUrl: "https://relay.example.com",
              // Optional. Default: 10000
              timeoutMs: 10000,
            },
          },
        },
      },
    }
    ```

CLI 等價：

```bash
    openclaw config set gateway.push.apns.relay.baseUrl https://relay.example.com
    ```

這個是做什麼的：

- 讓網關透過外部中繼發送 `push.test`、喚醒提示和重新連接喚醒。
    - 使用由配對的 iOS 應用程式轉發的註冊範圍發送授權。網關不需要全部署範圍的中繼 token。
    - 將每個中繼支援的註冊綁定到與 iOS 應用程式配對的網關身份，因此另一個網關無法重複使用已儲存的註冊。
    - 保持本地/手動的 iOS 構建直接使用 APNs。中繼支援的發送僅適用於通過中繼註冊的官方分發版本。
    - 必須與官方/TestFlight iOS 構建中內嵌的中繼基本 URL 匹配，以便註冊和發送流量能夠到達相同的中繼部署。

[[BLOCK_1]]

1. 安裝一個使用相同中繼基本 URL 編譯的官方/TestFlight iOS 構建。
2. 在網關上設定 `gateway.push.apns.relay.baseUrl`。
3. 將 iOS 應用程式與網關配對，並讓節點和操作員會話都能連接。
4. iOS 應用程式獲取網關身份，使用 App Attest 及應用程式收據向中繼註冊，然後將中繼支援的 `push.apns.register` 負載發佈到配對的網關。
5. 網關儲存中繼句柄和授權，然後將它們用於 `push.test`、喚醒提示和重新連接喚醒。

[[BLOCK_1]]
操作說明：
[[BLOCK_1]]

- 如果您將 iOS 應用程式切換到不同的網關，請重新連接應用程式，以便它可以發佈一個新的綁定到該網關的中繼註冊。
    - 如果您發佈了一個指向不同中繼部署的新 iOS 版本，應用程式會刷新其快取的中繼註冊，而不是重複使用舊的中繼來源。

相容性說明：

- `OPENCLAW_APNS_RELAY_BASE_URL` 和 `OPENCLAW_APNS_RELAY_TIMEOUT_MS` 仍然可以作為臨時環境覆蓋。
    - `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true` 仍然是僅限回環的開發逃生通道；請勿在設定中持久化 HTTP 轉發 URL。

請參閱 [iOS App](/platforms/ios#relay-backed-push-for-official-builds) 以了解端到端流程，以及 [Authentication and trust flow](/platforms/ios#authentication-and-trust-flow) 以了解中繼安全模型。

</Accordion>

<Accordion title="設定心跳（定期檢查）">
    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    }
    ```

- `every`: 持續時間字串 (`30m`, `2h`)。設定 `0m` 以禁用。
    - `target`: `last` | `whatsapp` | `telegram` | `discord` | `none`
    - `directPolicy`: `allow` (預設) 或 `block` 用於 DM 風格的心跳目標
    - 詳情請參閱 [Heartbeat](/gateway/heartbeat) 完整指南。

</Accordion>

<Accordion title="設定定時任務">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
        runLog: {
          maxBytes: "2mb",
          keepLines: 2000,
        },
      },
    }
    ```

- `sessionRetention`: 修剪來自 `sessions.json` 的已完成孤立執行會話 (預設 `24h`; 設定 `false` 以禁用)。
    - `runLog`: 根據大小和保留行數修剪 `cron/runs/<jobId>.jsonl`。
    - 參見 [Cron jobs](/automation/cron-jobs) 以獲取功能概述和 CLI 範例。

</Accordion>

<Accordion title="設定網路鉤子 (hooks)">
    在 Gateway 上啟用 HTTP 網路鉤子端點：

```json5
    {
      hooks: {
        enabled: true,
        token: "shared-secret",
        path: "/hooks",
        defaultSessionKey: "hook:ingress",
        allowRequestSessionKey: false,
        allowedSessionKeyPrefixes: ["hook:"],
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            agentId: "main",
            deliver: true,
          },
        ],
      },
    }
    ```

安全注意事項：
    - 將所有 hook/webhook 負載內容視為不受信任的輸入。
    - 除非進行嚴格範圍的除錯，否則保持不安全內容繞過標誌禁用 (`hooks.gmail.allowUnsafeExternalContent`, `hooks.mappings[].allowUnsafeExternalContent`)。
    - 對於基於 hook 的代理，建議使用強大的現代模型層級和嚴格的工具政策（例如僅限消息傳遞加上盡可能的沙盒化）。

請參閱 [full reference](/gateway/configuration-reference#hooks) 以獲取所有映射選項和 Gmail 整合資訊。

</Accordion>

<Accordion title="設定多代理路由">
    執行多個獨立的代理，並擁有各自的工作區和會話：

```json5
    {
      agents: {
        list: [
          { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
          { id: "work", workspace: "~/.openclaw/workspace-work" },
        ],
      },
      bindings: [
        { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
        { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
      ],
    }
    ```

請參閱 [Multi-Agent](/concepts/multi-agent) 和 [完整參考](/gateway/configuration-reference#multi-agent-routing) 以了解綁定規則和每個代理的訪問設定檔。

</Accordion>

<Accordion title="將設定拆分為多個檔案 ($include)">
    使用 `$include` 來組織大型設定：

```json5
    // ~/.openclaw/openclaw.json
    {
      gateway: { port: 18789 },
      agents: { $include: "./agents.json5" },
      broadcast: {
        $include: ["./clients/a.json5", "./clients/b.json5"],
      },
    }
    ```

- **單一檔案**：替換包含的物件
    - **檔案陣列**：按順序深度合併（後者優先）
    - **兄弟鍵**：在包含後合併（覆蓋包含的值）
    - **巢狀包含**：支援最多 10 層深
    - **相對路徑**：相對於包含的檔案解析
    - **錯誤處理**：對於缺失檔案、解析錯誤和循環包含提供清晰的錯誤訊息

</Accordion>
</AccordionGroup>

## Config hot reload

Gateway 會監控 `~/.openclaw/openclaw.json` 並自動應用變更 — 大多數設定不需要手動重啟。

### 重新載入模式

| 模式                   | 行為                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **`hybrid`** (預設) | 立即熱應用安全變更。對於關鍵變更自動重啟。                                               |
| **`hot`**              | 僅熱應用安全變更。當需要重啟時記錄警告 — 由你來處理。                                   |
| **`restart`**          | 在任何設定變更時重啟 Gateway，不論是否安全。                                             |
| **`off`**              | 禁用檔案監視。變更在下次手動重啟時生效。                                               |

```json5
{
  gateway: {
    reload: { mode: "hybrid", debounceMs: 300 },
  },
}
````

### 什麼是熱應用（hot-applies）與什麼需要重啟（restart）

大多數欄位都可以熱應用而不需要停機。在 `hybrid` 模式下，需重啟的變更會自動處理。

| 類別       | 欄位                                                 | 需要重啟？ |
| ---------- | ---------------------------------------------------- | ---------- |
| 通道       | `channels.*`, `web` (WhatsApp) — 所有內建及擴充通道  | 否         |
| 代理與模型 | `agent`, `agents`, `models`, `routing`               | 否         |
| 自動化     | `hooks`, `cron`, `agent.heartbeat`                   | 否         |
| 會話與訊息 | `session`, `messages`                                | 否         |
| 工具與媒體 | `tools`, `browser`, `skills`, `audio`, `talk`        | 否         |
| UI 與其他  | `ui`, `logging`, `identity`, `bindings`              | 否         |
| 閘道伺服器 | `gateway.*` (port, bind, auth, tailscale, TLS, HTTP) | **是**     |
| 基礎設施   | `discovery`, `canvasHost`, `plugins`                 | **是**     |

<Note>
`gateway.reload` 和 `gateway.remote` 是例外 — 更改它們不會觸發重啟。
</Note>

## Config RPC (程式化更新)

<Note>
控制平面寫入 RPC (`config.apply`, `config.patch`, `update.run`) 的速率限制為每個 `deviceId+clientIp` **每 60 秒 3 個請求**。當受到限制時，RPC 會返回 `UNAVAILABLE` 和 `retryAfterMs`。
</Note>

<AccordionGroup>
  <Accordion title="config.apply (完全替換)">
    驗證並寫入完整的設定，並在一步驟中重新啟動 Gateway。

<Warning>
    `config.apply` 會取代 **整個設定**。請使用 `config.patch` 進行部分更新，或使用 `openclaw config set` 更新單一鍵值。
</Warning>

Params:

- `raw` (字串) — 整個設定的 JSON5 負載
  - `baseHash` (可選) — 來自 `config.get` 的設定雜湊（當設定存在時必填）
  - `sessionKey` (可選) — 重啟後喚醒 ping 的會話金鑰
  - `note` (可選) — 重啟哨兵的備註
  - `restartDelayMs` (可選) — 重啟前的延遲（預設為 2000）

重啟請求在已有請求待處理/進行中時會被合併，並且在重啟週期之間會有 30 秒的冷卻時間。

````bash
    openclaw gateway call config.get --params '{}'  # capture payload.hash
    openclaw gateway call config.apply --params '{
      "raw": "{ agents: { defaults: { workspace: \"~/.openclaw/workspace\" } } }",
      "baseHash": "<hash>",
      "sessionKey": "agent:main:whatsapp:dm:+15555550123"
    }'
    ```

</Accordion>

<Accordion title="config.patch (部分更新)">
    將部分更新合併到現有的設定中（JSON 合併補丁語義）：

- 物件遞迴合併
    - `null` 刪除一個鍵
    - 陣列替換

Params:

- `raw` (字串) — 僅包含要更改的鍵的 JSON5
    - `baseHash` (必填) — 來自 `config.get` 的設定雜湊
    - `sessionKey`, `note`, `restartDelayMs` — 與 `config.apply` 相同

重啟行為符合 `config.apply`：合併的待處理重啟加上重啟週期之間的 30 秒冷卻時間。

```bash
    openclaw gateway call config.patch --params '{
      "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
      "baseHash": "<hash>"
    }'
    ```

</Accordion>
</AccordionGroup>

## 環境變數

OpenClaw 從父進程讀取環境變數以及：

- `.env` 從當前工作目錄（如果存在）
- `~/.openclaw/.env` （全域備援）

既沒有檔案會覆蓋現有的環境變數。您也可以在設定中設置內聯環境變數：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
````

<Accordion title="Shell 環境匯入（選用）">
  如果啟用且預期的鍵未設置，OpenClaw 將執行您的登入 shell 並僅匯入缺失的鍵：

```json5
{
  env: {
    shellEnv: { enabled: true, timeoutMs: 15000 },
  },
}
```

Env var equivalent: `OPENCLAW_LOAD_SHELL_ENV=1`  
</Accordion>

<Accordion title="環境變數在設定值中的替代">
  在任何設定字串值中參考環境變數使用 `${VAR_NAME}`:

```json5
{
  gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}" } } },
}
```

[[BLOCK_1]]

- 只有大寫名稱匹配: `[A-Z_][A-Z0-9_]*`
- 缺少/空的變數在載入時會拋出錯誤
- 使用 `$${VAR}` 進行字面輸出轉義
- 在 `$include` 檔案內部運作
- 行內替換: `"${BASE}/v1"` → `"https://api.example.com/v1"`

</Accordion>

<Accordion title="秘密引用 (env, file, exec)">
  對於支援 SecretRef 物件的欄位，您可以使用：

```json5
{
  models: {
    providers: {
      openai: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
  skills: {
    entries: {
      "nano-banana-pro": {
        apiKey: {
          source: "file",
          provider: "filemain",
          id: "/skills/entries/nano-banana-pro/apiKey",
        },
      },
    },
  },
  channels: {
    googlechat: {
      serviceAccountRef: {
        source: "exec",
        provider: "vault",
        id: "channels/googlechat/serviceAccount",
      },
    },
  },
}
```

SecretRef 詳細資訊（包括 `secrets.providers` 用於 `env`/`file`/`exec`）在 [Secrets Management](/gateway/secrets) 中。支援的憑證路徑列在 [SecretRef Credential Surface](/reference/secretref-credential-surface) 中。

請參閱 [Environment](/help/environment) 以獲取完整的優先順序和來源。

## Full reference

有關完整的逐欄參考，請參閱 **[Configuration Reference](/gateway/configuration-reference)**。

---

_Related: [設定範例](/gateway/configuration-examples) · [設定參考](/gateway/configuration-reference) · [醫生](/gateway/doctor)_
