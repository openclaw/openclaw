---
summary: "設定概覽：常見任務、快速設定，以及完整參考資料的連結"
read_when:
  - 首次設定 OpenClaw
  - 尋找常見設定模式
  - 導覽至特定設定區段
title: "設定"
---

# 設定

OpenClaw 從 `~/.openclaw/openclaw.json` 讀取一個可選的 <Tooltip tip="JSON5 支援註解和尾隨逗號">**JSON5**</Tooltip> 設定檔案。

如果檔案遺失，OpenClaw 會使用安全預設值。新增設定的常見原因：

- 連接頻道並控制誰可以向智慧代理傳送訊息
- 設定模型、工具、沙箱隔離或自動化（cron、hooks）
- 調整工作階段、媒體、網路或使用者介面

查看[完整參考資料](/gateway/configuration-reference)了解詳情。

<Tip>
**剛接觸設定？** 從 `openclaw onboard` 開始進行互動式設定，或查看[設定範例](/gateway/configuration-examples)指南，獲取完整的複製貼上設定。
</Tip>

## 最小設定

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
    openclaw onboard       # 完整設定精靈
    openclaw configure     # 設定精靈
    ```
  </Tab>
  <Tab title="CLI（單行指令）">
    ```bash
    openclaw config get agents.defaults.workspace
    openclaw config set agents.defaults.heartbeat.every "2h"
    openclaw config unset tools.web.search.apiKey
    ```
  </Tab>
  <Tab title="控制使用者介面">
    開啟 [http://127.0.0.1:18789](http://127.0.0.1:18789) 並使用 **Config** 索引標籤。
    控制使用者介面會根據設定結構描述呈現表單，並提供 **Raw JSON** 編輯器作為緊急出口。
  </Tab>
  <Tab title="直接編輯">
    直接編輯 `~/.openclaw/openclaw.json`。Gateway會監控該檔案並自動套用變更（請參閱[熱重載](#config-hot-reload)）。
  </Tab>
</Tabs>

## 嚴格驗證

<Warning>
OpenClaw 僅接受完全符合結構描述的設定。未知的鍵、格式錯誤的類型或無效的值會導致 Gateway**拒絕啟動**。唯一的根層級例外是 `$schema` (字串)，因此編輯器可以附加 JSON Schema 中繼資料。
</Warning>

驗證失敗時：

- Gateway不會啟動
- 只有診斷命令有效 (`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`)
- 執行 `openclaw doctor` 查看確切問題
- 執行 `openclaw doctor --fix` (或 `--yes`) 套用修復

## 常見任務

<AccordionGroup>
  <Accordion title="設定頻道 (WhatsApp, Telegram, Discord 等)">
    每個頻道在 `channels.<provider>` 下都有自己的設定區段。請參閱專用頻道頁面以了解設定步驟：

    - [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/channels/telegram) — `channels.telegram`
    - [Discord](/channels/discord) — `channels.discord`
    - [Slack](/channels/slack) — `channels.slack`
    - [Signal](/channels/signal) — `channels.signal`
    - [iMessage](/channels/imessage) — `channels.imessage`
    - [Google Chat](/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/channels/mattermost) — `channels.mattermost`
    - [MS Teams](/channels/msteams) — `channels.msteams`

    所有頻道共享相同的私訊策略模式：

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // 僅適用於 allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="選擇並設定模型">
    設定主要模型和可選的備援：

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

    - `agents.defaults.models` 定義模型目錄並充當 `/model` 的允許清單。
    - 模型引用使用 `provider/model` 格式（例如 `anthropic/claude-opus-4-6`）。
    - 請參閱 [Models CLI](/concepts/models) 以了解在聊天中切換模型，以及 [Model Failover](/concepts/model-failover) 以了解憑證輪換和備援行為。
    - 對於自訂/自託管供應商，請參閱參考資料中的 [Custom providers](/gateway/configuration-reference#custom-providers-and-base-urls)。

  </Accordion>

  <Accordion title="控制誰可以向智慧代理傳送訊息">
    私訊存取權限由每個頻道透過 `dmPolicy` 控制：

    - `"pairing"` (預設)：未知發送者會收到一次性配對碼以供批准
    - `"allowlist"`：僅限 `allowFrom` 中的發送者（或已配對的允許儲存）
    - `"open"`：允許所有入站私訊（需要 `allowFrom: ["*"]`）
    - `"disabled"`：忽略所有私訊

    對於群組，請使用 `groupPolicy` + `groupAllowFrom` 或特定頻道允許清單。

    請參閱[完整參考資料](/gateway/configuration-reference#dm-and-group-access)以了解每個頻道的詳細資訊。

  </Accordion>

  <Accordion title="設定群組聊天提及門控">
    群組訊息預設為**需要提及**。為每個智慧代理設定模式：

    ```json5
    {
      agents: {
        list: [
          {
            id: "main",
            groupChat: {
              mentionPatterns: [" @openclaw", "openclaw"],
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

    - **中繼資料提及**：原生 @提及 (WhatsApp 點擊提及、Telegram @polymarket-bot-v0-py/bot.py 等)
    - **文字模式**：`mentionPatterns` 中的正規表達式模式
    - 請參閱[完整參考資料](/gateway/configuration-reference#group-chat-mention-gating)以了解每個頻道的覆寫和自聊天模式。

  </Accordion>

  <Accordion title="設定工作階段與重設">
    工作階段控制對話的連續性和隔離：

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // 建議用於多使用者
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (共用) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - 請參閱 [Session Management](/concepts/session) 以了解範圍、身份連結和傳送策略。
    - 請參閱[完整參考資料](/gateway/configuration-reference#session)以了解所有欄位。

  </Accordion>

  <Accordion title="啟用沙箱隔離">
    在獨立的 Docker 容器中執行智慧代理工作階段：

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

    首先建置映像檔：`scripts/sandbox-setup.sh`

    請參閱 [Sandboxing](/gateway/sandboxing) 以了解完整指南，並參閱[完整參考資料](/gateway/configuration-reference#sandbox)以了解所有選項。

  </Accordion>

  <Accordion title="設定心跳 (定期檢查)">
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

    - `every`：持續時間字串 (`30m`、`2h`)。設為 `0m` 以停用。
    - `target`：`last` | `whatsapp` | `telegram` | `discord` | `none`
    - 請參閱 [Heartbeat](/gateway/heartbeat) 以了解完整指南。

  </Accordion>

  <Accordion title="設定 cron 任務">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
      },
    }
    ```

    請參閱 [Cron jobs](/automation/cron-jobs) 以了解功能概觀和 CLI 範例。

  </Accordion>

  <Accordion title="設定 Webhook (hooks)">
    在 Gateway上啟用 HTTP Webhook 端點：

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

    請參閱[完整參考資料](/gateway/configuration-reference#hooks)以了解所有映射選項和 Gmail 整合。

  </Accordion>

  <Accordion title="設定多智慧代理路由">
    執行多個獨立的智慧代理，並具有獨立的工作區和工作階段：

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

    請參閱 [Multi-Agent](/concepts/multi-agent) 和[完整參考資料](/gateway/configuration-reference#multi-agent-routing)以了解繫結規則和每個智慧代理的存取設定檔。

  </Accordion>

  <Accordion title="將設定分割成多個檔案 ($include)">
    使用 `$include` 組織大型設定：

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

    - **單一檔案**：替換包含物件
    - **檔案陣列**：依序深度合併（後者勝出）
    - **同級鍵**：在包含之後合併（覆寫包含的值）
    - **巢狀包含**：支援最多 10 層深度
    - **相對路徑**：相對於包含檔案解析
    - **錯誤處理**：針對遺失檔案、解析錯誤和循環包含提供清晰的錯誤

  </Accordion>
</AccordionGroup>

## 設定熱重載

