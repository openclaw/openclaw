---
summary: "設定概覽：常用任務、快速設定以及完整參考指南的連結"
read_when:
  - 初次設定 OpenClaw 時
  - 尋找常用的設定模式時
  - 前往特定設定區塊時
title: "設定"
---

# 設定

OpenClaw 從 `~/.openclaw/openclaw.json` 讀取選填的 <Tooltip tip="JSON5 支援註釋和結尾逗號">**JSON5**</Tooltip> 設定。

如果該檔案不存在，OpenClaw 將使用安全預設值。添加設定的常見原因包括：

- 連接頻道並控制誰可以傳送訊息給機器人
- 設定模型、工具、沙箱隔離或自動化（cron、hooks）
- 微調工作階段、媒體、網路或 UI

請參閱[完整參考指南](/gateway/configuration-reference)了解所有可用欄位。

<Tip>
**初次進行設定？** 從 `openclaw onboard` 開始進行互動式設定，或查看 [設定範例](/gateway/configuration-examples) 指南以獲取完整的複製貼上設定。
</Tip>

## 最小化設定

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
  <Tab title="Control UI">
    開啟 [http://127.0.0.1:18789](http://127.0.0.1:18789) 並使用 **Config** 標籤頁。
    Control UI 會根據設定 Schema 渲染表單，並提供 **Raw JSON** 編輯器作為備用方案。
  </Tab>
  <Tab title="直接編輯">
    直接編輯 `~/.openclaw/openclaw.json`。Gateway 會監控該檔案並自動套用變更（請參閱 [熱重新載入](#config-hot-reload)）。
  </Tab>
</Tabs>

## 嚴格驗證

<Warning>
OpenClaw 僅接受完全符合 Schema 的設定。未知的鍵名、格式錯誤的類型或無效值將導致 Gateway **拒絕啟動**。唯一的根層級例外是 `$schema` (string)，以便編輯器附加 JSON Schema 中繼資料。
</Warning>

當驗證失敗時：

- Gateway 不會啟動
- 僅診斷指令可運作（`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`）
- 執行 `openclaw doctor` 查看確切問題
- 執行 `openclaw doctor --fix`（或 `--yes`）進行修復

## 常見任務

<AccordionGroup>
  <Accordion title="設定頻道（WhatsApp、Telegram、Discord 等）">
    每個頻道在 `channels.<provider>` 下都有自己的設定區塊。請參閱專屬頻道頁面了解設定步驟：

    - [WhatsApp](/channels/whatsapp) — `channels.whatsapp`
    - [Telegram](/channels/telegram) — `channels.telegram`
    - [Discord](/channels/discord) — `channels.discord`
    - [Slack](/channels/slack) — `channels.slack`
    - [Signal](/channels/signal) — `channels.signal`
    - [iMessage](/channels/imessage) — `channels.imessage`
    - [Google Chat](/channels/googlechat) — `channels.googlechat`
    - [Mattermost](/channels/mattermost) — `channels.mattermost`
    - [MS Teams](/channels/msteams) — `channels.msteams`

    所有頻道共享相同的私訊政策模式：

    ```json5
    {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:abc",
          dmPolicy: "pairing",   // pairing | allowlist | open | disabled
          allowFrom: ["tg:123"], // 僅用於 allowlist/open
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="選擇並設定模型">
    設定主要模型和選填的備用模型：

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

    - `agents.defaults.models` 定義了模型型錄，並作為 `/model` 指令的允許清單。
    - 模型參考使用 `provider/model` 格式（例如 `anthropic/claude-opus-4-6`）。
    - 關於在聊天中切換模型請參閱 [模型 CLI](/concepts/models)，關於憑證輪轉與備用行為請參閱 [模型容錯移轉](/concepts/model-failover)。
    - 對於自定義/自託管供應商，請參閱參考指南中的 [自定義供應商與基礎 URL](/gateway/configuration-reference#custom-providers-and-base-urls)。

  </Accordion>

  <Accordion title="控制誰可以傳送訊息給機器人">
    私訊存取權限透過 `dmPolicy` 在每個頻道進行控制：

    - `"pairing"`（預設）：未知發送者將獲得一次性配對碼以供核准
    - `"allowlist"`：僅限 `allowFrom` 中的發送者（或已配對的允許儲存空間）
    - `"open"`：允許所有傳入的私訊（需要 `allowFrom: ["*"]`）
    - `"disabled"`：忽略所有私訊

    對於群組，請使用 `groupPolicy` + `groupAllowFrom` 或特定頻道的允許清單。

    請參閱[完整參考指南](/gateway/configuration-reference#dm-and-group-access)了解各頻道的詳細資訊。

  </Accordion>

  <Accordion title="設定群組聊天提及門檻">
    群組訊息預設為**需要提及**。可為每個智慧代理設定模式：

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

    - **中繼資料提及**：原生 @-提及（WhatsApp 點擊提及、Telegram @bot 等）
    - **文字模式**：`mentionPatterns` 中的 Regex 模式
    - 請參閱[完整參考指南](/gateway/configuration-reference#group-chat-mention-gating)了解各頻道覆寫和自我聊天模式。

  </Accordion>

  <Accordion title="設定工作階段與重設">
    工作階段控制對話的連續性與隔離：

    ```json5
    {
      session: {
        dmScope: "per-channel-peer",  // 多使用者建議設定
        reset: {
          mode: "daily",
          atHour: 4,
          idleMinutes: 120,
        },
      },
    }
    ```

    - `dmScope`: `main` (共享) | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
    - 請參閱[工作階段管理](/concepts/session)了解範圍劃分、身分連結和傳送政策。
    - 請參閱[完整參考指南](/gateway/configuration-reference#session)了解所有欄位。

  </Accordion>

  <Accordion title="啟用沙箱隔離">
    在隔離的 Docker 容器中執行智慧代理工作階段：

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

    請先建置映像檔：`scripts/sandbox-setup.sh`

    請參閱[沙箱隔離](/gateway/sandboxing)了解完整指南，並參閱[完整參考指南](/gateway/configuration-reference#sandbox)了解所有選項。

  </Accordion>

  <Accordion title="設定 Heartbeat（定期檢查）">
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

    - `every`: 持續時間字串（`30m`、`2h`）。設定 `0m` 以停用。
    - `target`: `last` | `whatsapp` | `telegram` | `discord` | `none`
    - 請參閱 [Heartbeat](/gateway/heartbeat) 了解完整指南。

  </Accordion>

  <Accordion title="設定 Cron 排程任務">
    ```json5
    {
      cron: {
        enabled: true,
        maxConcurrentRuns: 2,
        sessionRetention: "24h",
      },
    }
    ```

    請參閱 [Cron 任務](/automation/cron-jobs) 了解功能概覽和 CLI 範例。

  </Accordion>

  <Accordion title="設定 Webhooks (hooks)">
    在 Gateway 上啟用 HTTP Webhook 端點：

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

    請參閱[完整參考指南](/gateway/configuration-reference#hooks)了解所有對應選項和 Gmail 整合。

  </Accordion>

  <Accordion title="設定多智慧代理路由">
    執行多個具備獨立工作空間和工作階段的隔離智慧代理：

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

    請參閱[多智慧代理](/concepts/multi-agent)及[完整參考指南](/gateway/configuration-reference#multi-agent-routing)了解綁定規則和各智慧代理的存取設定。

  </Accordion>

  <Accordion title="將設定拆分為多個檔案 ($include)">
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

    - **單一檔案**：替換包含它的物件
    - **檔案陣列**：按順序深度合併（後者優先）
    - **同級鍵名**：在 include 之後合併（覆寫被包含的值）
    - **巢狀 include**：支援深達 10 層
    - **相對路徑**：相對於包含檔案進行解析
    - **錯誤處理**：針對遺失檔案、解析錯誤和循環包含提供清晰的錯誤訊息

  </Accordion>
</AccordionGroup>

## 設定熱重新載入

Gateway 會監控 `~/.openclaw/openclaw.json` 並自動套用變更——大多數設定無需手動重新啟動。

###
