---
summary: "WhatsApp（網頁頻道）整合：登入、收件匣、回覆、媒體與營運"
read_when:
  - 處理 WhatsApp／網頁頻道行為或收件匣路由時
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:46Z
---

# WhatsApp（網頁頻道）

狀態：僅支援透過 Baileys 的 WhatsApp Web。Gateway 閘道器 擁有工作階段（sessions）。

## 快速開始（新手）

1. 盡可能使用**獨立的電話號碼**（建議）。
2. 在 `~/.openclaw/openclaw.json` 中設定 WhatsApp。
3. 執行 `openclaw channels login` 掃描 QR Code（已連結裝置）。
4. 啟動 Gateway 閘道器。

最小設定：

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## 目標

- 在單一 Gateway 閘道器 程序中支援多個 WhatsApp 帳號（multi-account）。
- 可預測的路由：回覆會回到 WhatsApp，不進行模型路由。
- 模型能看到足夠的上下文以理解引用回覆。

## 設定寫入

預設允許 WhatsApp 寫入由 `/config set|unset` 觸發的設定更新（需要 `commands.config: true`）。

停用方式：

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## 架構（各自負責什麼）

- **Gateway 閘道器**：擁有 Baileys socket 與收件匣迴圈。
- **CLI／macOS 應用程式**：與 Gateway 閘道器 通訊；不直接使用 Baileys。
- **主動監聽器**：外送訊息需要；否則送出會快速失敗。

## 取得電話號碼（兩種模式）

WhatsApp 需要真實的行動電話號碼進行驗證。VoIP 與虛擬號碼通常會被封鎖。以下是兩種支援在 WhatsApp 上執行 OpenClaw 的方式：

### 專用號碼（建議）

為 OpenClaw 使用**獨立的電話號碼**。最佳使用體驗、乾淨的路由，且沒有自我聊天的怪異行為。理想配置：**備用／舊的 Android 手機 + eSIM**。讓裝置保持 Wi‑Fi 與電源，並透過 QR 連結。

**WhatsApp Business：** 可在同一裝置上使用不同號碼的 WhatsApp Business。非常適合將個人 WhatsApp 與 OpenClaw 分開——安裝 WhatsApp Business，並在其中註冊 OpenClaw 的號碼。

**範例設定（專用號碼、單一使用者允許清單）：**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**配對模式（選用）：**  
若你想使用配對而非允許清單，將 `channels.whatsapp.dmPolicy` 設為 `pairing`。未知寄件者會收到配對碼；使用下列指令核准：
`openclaw pairing approve whatsapp <code>`

### 個人號碼（備援）

快速備援方案：在**你自己的號碼**上執行 OpenClaw。測試時對自己傳訊（WhatsApp「傳訊給自己」），避免打擾聯絡人。設定與實驗期間，預期需在主手機上讀取驗證碼。**必須啟用自我聊天模式。**  
當精靈詢問你的個人 WhatsApp 號碼時，請輸入你將用來傳訊的電話（擁有者／寄件者），而非助理號碼。

**範例設定（個人號碼、自我聊天）：**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

自我聊天回覆在設定 `[{identity.name}]` 時會成為預設（否則為 `[openclaw]`），
前提是 `messages.responsePrefix` 未設定。可明確設定以自訂或停用
該前綴（使用 `""` 以移除）。

### 號碼來源建議

- **當地電信商的 eSIM**（最可靠）
  - 奧地利：[hot.at](https://www.hot.at)
  - 英國：[giffgaff](https://www.giffgaff.com) — 免費 SIM，無合約
- **預付 SIM** — 便宜，只需接收一次驗證 SMS

**避免：** TextNow、Google Voice、多數「免費 SMS」服務 — WhatsApp 對這些封鎖非常嚴格。

**提示：** 該號碼只需接收一次驗證 SMS。之後，WhatsApp Web 工作階段會透過 `creds.json` 持續存在。

## 為什麼不用 Twilio？

- 早期的 OpenClaw 版本支援 Twilio 的 WhatsApp Business 整合。
- WhatsApp Business 號碼不適合個人助理。
- Meta 強制 24 小時回覆視窗；若過去 24 小時未回覆，商業號碼無法主動發送新訊息。
- 高頻或「聊天式」使用會觸發嚴格封鎖，因為商業帳號不適合發送大量個人助理訊息。
- 結果：傳遞不穩定且常被封鎖，因此已移除支援。

## 登入與憑證

- 登入指令：`openclaw channels login`（透過已連結裝置的 QR）。
- 多帳號登入：`openclaw channels login --account <id>`（`<id>` = `accountId`）。
- 預設帳號（省略 `--account` 時）：若存在 `default` 則使用之，否則使用第一個已設定的帳號 id（排序後）。
- 憑證儲存在 `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`。
- 備份副本位於 `creds.json.bak`（損毀時復原）。
- 相容舊版：較舊的安裝會將 Baileys 檔案直接存於 `~/.openclaw/credentials/`。
- 登出：`openclaw channels logout`（或 `--account <id>`）會刪除 WhatsApp 驗證狀態（但保留共用的 `oauth.json`）。
- 已登出 socket ⇒ 錯誤會指示重新連結。

## 進站流程（私訊 + 群組）

- WhatsApp 事件來自 `messages.upsert`（Baileys）。
- 為避免在測試／重啟時累積事件處理器，關機時會解除收件匣監聽器。
- 狀態／廣播聊天會被忽略。
- 私聊使用 E.164；群組使用 group JID。
- **私訊政策**：`channels.whatsapp.dmPolicy` 控制私聊存取（預設：`pairing`）。
  - 配對：未知寄件者會收到配對碼（透過 `openclaw pairing approve whatsapp <code>` 核准；代碼 1 小時後過期）。
  - 開放：需要 `channels.whatsapp.allowFrom` 包含 `"*"`。
  - 你已連結的 WhatsApp 號碼會被隱含信任，因此自我訊息會略過 `channels.whatsapp.dmPolicy` 與 `channels.whatsapp.allowFrom` 檢查。

### 個人號碼模式（備援）

若你在**個人 WhatsApp 號碼**上執行 OpenClaw，請啟用 `channels.whatsapp.selfChatMode`（見上方範例）。

行為：

- 外送私訊不會觸發配對回覆（避免打擾聯絡人）。
- 進站未知寄件者仍遵循 `channels.whatsapp.dmPolicy`。
- 自我聊天模式（allowFrom 包含你的號碼）會避免自動已讀回條，並忽略提及 JID。
- 非自我聊天的私訊會送出已讀回條。

## 已讀回條

預設情況下，Gateway 閘道器 在接受進站 WhatsApp 訊息後會標記為已讀（藍勾）。

全域停用：

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

依帳號停用：

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

注意事項：

- 自我聊天模式一律略過已讀回條。

## WhatsApp FAQ：發送訊息 + 配對

**連結 WhatsApp 後，OpenClaw 會不會傳訊給隨機聯絡人？**  
不會。預設私訊政策是**配對**，因此未知寄件者只會收到配對碼，且其訊息**不會被處理**。OpenClaw 只會回覆它收到的聊天，或你明確觸發的送出（代理程式／CLI）。

**WhatsApp 的配對如何運作？**  
配對是針對未知寄件者的私訊閘門：

- 新寄件者的第一則私訊會回傳一個短碼（訊息不會被處理）。
- 使用：`openclaw pairing approve whatsapp <code>` 核准（清單使用 `openclaw pairing list whatsapp`）。
- 代碼 1 小時後過期；每個頻道的待處理請求上限為 3。

**多人能否在同一個 WhatsApp 號碼上使用不同的 OpenClaw 實例？**  
可以，透過 `bindings` 將每位寄件者路由到不同的代理程式（對等 `kind: "dm"`，寄件者 E.164 如 `+15551234567`）。回覆仍來自**同一個 WhatsApp 帳號**，且私聊會收斂到各代理程式的主要工作階段，因此請**每人使用一個代理程式**。私訊存取控制（`dmPolicy`/`allowFrom`）在每個 WhatsApp 帳號層級是全域的。請參閱 [Multi-Agent Routing](/concepts/multi-agent)。

**為什麼精靈會詢問我的電話號碼？**  
精靈用它來設定你的**允許清單／擁有者**，以允許你自己的私訊。它不會用於自動發送。若你在個人 WhatsApp 號碼上執行，請使用同一個號碼並啟用 `channels.whatsapp.selfChatMode`。

## 訊息正規化（模型所見內容）

- `Body` 是目前訊息本文與信封。
- 引用回覆的上下文**一定會附加**：

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- 同時設定回覆中繼資料：
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = 引用的本文或媒體佔位符
  - `ReplyToSender` = 已知時的 E.164
- 僅媒體的進站訊息使用佔位符：
  - `<media:image|video|audio|document|sticker>`

## 群組

- 群組對應至 `agent:<agentId>:whatsapp:group:<jid>` 工作階段。
- 群組政策：`channels.whatsapp.groupPolicy = open|disabled|allowlist`（預設 `allowlist`）。
- 啟用模式：
  - `mention`（預設）：需要 @提及或正則符合。
  - `always`：一律觸發。
- `/activation mention|always` 僅限擁有者，且必須作為單獨訊息送出。
- 擁有者 = `channels.whatsapp.allowFrom`（或未設定時為自身 E.164）。
- **歷史注入**（僅待處理）：
  - 最近的*未處理*訊息（預設 50）插入於：
    `[Chat messages since your last reply - for context]`（已在工作階段中的訊息不會重新注入）
  - 目前訊息位於：
    `[Current message - respond to this]`
  - 會附加寄件者後綴：`[from: Name (+E164)]`
- 群組中繼資料快取 5 分鐘（主題 + 參與者）。

## 回覆傳遞（串接）

- WhatsApp Web 會送出標準訊息（目前 Gateway 閘道器 不支援引用回覆串接）。
- 此頻道會忽略回覆標籤。

## 確認反應（收件即自動反應）

WhatsApp 可在收到訊息後立即自動送出表情符號反應，於機器人產生回覆之前，提供即時回饋給使用者，表示訊息已收到。

**設定：**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**選項：**

- `emoji`（字串）：用於確認的表情符號（例如「👀」、「✅」、「📨」）。空白或省略 = 停用功能。
- `direct`（布林，預設：`true`）：在私聊／DM 中送出反應。
- `group`（字串，預設：`"mentions"`）：群組聊天行為：
  - `"always"`：對所有群組訊息反應（即使沒有 @提及）
  - `"mentions"`：僅在機器人被 @提及時反應
  - `"never"`：群組中永不反應

**依帳號覆寫：**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**行為說明：**

- 反應會在收到訊息後**立即**送出，早於輸入中指示或機器人回覆。
- 在啟用 `requireMention: false`（啟用：一律） 的群組中，`group: "mentions"` 會對所有訊息反應（不僅限 @提及）。
- Fire-and-forget：反應失敗會被記錄，但不會阻止機器人回覆。
- 群組反應會自動包含參與者 JID。
- WhatsApp 會忽略 `messages.ackReaction`；請改用 `channels.whatsapp.ackReaction`。

## 代理程式工具（反應）

- 工具：`whatsapp`，含 `react` 動作（`chatJid`、`messageId`、`emoji`，選用 `remove`）。
- 選用：`participant`（群組寄件者）、`fromMe`（對自己訊息反應）、`accountId`（多帳號）。
- 反應移除語意：請見 [/tools/reactions](/tools/reactions)。
- 工具門控：`channels.whatsapp.actions.reactions`（預設：啟用）。

## 限制

- 外送文字會分段至 `channels.whatsapp.textChunkLimit`（預設 4000）。
- 選用換行分段：設定 `channels.whatsapp.chunkMode="newline"`，在長度分段前依空白行（段落邊界）切分。
- 進站媒體儲存上限由 `channels.whatsapp.mediaMaxMb` 控制（預設 50 MB）。
- 外送媒體項目上限為 `agents.defaults.mediaMaxMb`（預設 5 MB）。

## 外送（文字 + 媒體）

- 使用啟用中的網頁監聽器；若 Gateway 閘道器 未執行則報錯。
- 文字分段：每則最多 4k（可透過 `channels.whatsapp.textChunkLimit` 設定，選用 `channels.whatsapp.chunkMode`）。
- 媒體：
  - 支援圖片／影片／音訊／文件。
  - 音訊以 PTT 送出；`audio/ogg` ⇒ `audio/ogg; codecs=opus`。
  - 只有第一個媒體項目可加上說明文字。
  - 媒體抓取支援 HTTP(S) 與本機路徑。
  - 動畫 GIF：WhatsApp 期望使用具 `gifPlayback: true` 的 MP4 以內嵌循環。
    - CLI：`openclaw message send --media <mp4> --gif-playback`
    - Gateway 閘道器：`send` 參數包含 `gifPlayback: true`

## 語音備忘（PTT 音訊）

WhatsApp 會將音訊以**語音備忘**（PTT 氣泡）送出。

- 最佳結果：OGG/Opus。OpenClaw 會將 `audio/ogg` 重寫為 `audio/ogg; codecs=opus`。
- `[[audio_as_voice]]` 在 WhatsApp 上會被忽略（音訊已以語音備忘形式送出）。

## 媒體限制與最佳化

- 預設外送上限：5 MB（每個媒體項目）。
- 覆寫：`agents.defaults.mediaMaxMb`。
- 圖片會自動最佳化為上限內的 JPEG（調整尺寸 + 品質掃描）。
- 超過上限的媒體 ⇒ 錯誤；媒體回覆會退回為文字警告。

## 心跳

- **Gateway 閘道器 心跳**：記錄連線健康狀態（`web.heartbeatSeconds`，預設 60 秒）。
- **代理程式心跳**：可依代理程式設定（`agents.list[].heartbeat`），或全域
  透過 `agents.defaults.heartbeat`（當未設定每代理程式項目時的後備）。
  - 使用已設定的心跳提示（預設：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）+ `HEARTBEAT_OK` 略過行為。
  - 傳遞預設送往最後使用的頻道（或設定的目標）。

## 重新連線行為

- 退避策略：`web.reconnect`：
  - `initialMs`、`maxMs`、`factor`、`jitter`、`maxAttempts`。
- 若達到 maxAttempts，網頁監控會停止（降級）。
- 已登出 ⇒ 停止並需要重新連結。

## 設定速查

- `channels.whatsapp.dmPolicy`（私訊政策：配對／允許清單／開放／停用）。
- `channels.whatsapp.selfChatMode`（同機設定；機器人使用你的個人 WhatsApp 號碼）。
- `channels.whatsapp.allowFrom`（私訊允許清單）。WhatsApp 使用 E.164 電話號碼（無使用者名稱）。
- `channels.whatsapp.mediaMaxMb`（進站媒體儲存上限）。
- `channels.whatsapp.ackReaction`（收件即自動反應：`{emoji, direct, group}`）。
- `channels.whatsapp.accounts.<accountId>.*`（每帳號設定 + 選用 `authDir`）。
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb`（每帳號進站媒體上限）。
- `channels.whatsapp.accounts.<accountId>.ackReaction`（每帳號確認反應覆寫）。
- `channels.whatsapp.groupAllowFrom`（群組寄件者允許清單）。
- `channels.whatsapp.groupPolicy`（群組政策）。
- `channels.whatsapp.historyLimit`／`channels.whatsapp.accounts.<accountId>.historyLimit`（群組歷史上下文；`0` 停用）。
- `channels.whatsapp.dmHistoryLimit`（私訊歷史上限（以使用者輪次計））。每使用者覆寫：`channels.whatsapp.dms["<phone>"].historyLimit`。
- `channels.whatsapp.groups`（群組允許清單 + 提及門控預設；使用 `"*"` 以允許全部）
- `channels.whatsapp.actions.reactions`（WhatsApp 工具反應門控）。
- `agents.list[].groupChat.mentionPatterns`（或 `messages.groupChat.mentionPatterns`）
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix`（進站前綴；每帳號：`channels.whatsapp.accounts.<accountId>.messagePrefix`；已棄用：`messages.messagePrefix`）
- `messages.responsePrefix`（外送前綴）
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model`（選用覆寫）
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*`（每代理程式覆寫）
- `session.*`（scope、idle、store、mainKey）
- `web.enabled`（為 false 時停用頻道啟動）
- `web.heartbeatSeconds`
- `web.reconnect.*`

## 記錄 + 疑難排解

- 子系統：`whatsapp/inbound`、`whatsapp/outbound`、`web-heartbeat`、`web-reconnect`。
- 記錄檔：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`（可設定）。
- 疑難排解指南：[Gateway troubleshooting](/gateway/troubleshooting)。

## 疑難排解（快速）

**未連結／需要 QR 登入**

- 症狀：`channels status` 顯示 `linked: false` 或警告「Not linked」。
- 修復：在 閘道器主機 上執行 `openclaw channels login` 並掃描 QR（WhatsApp → 設定 → 已連結裝置）。

**已連結但已中斷／重新連線迴圈**

- 症狀：`channels status` 顯示 `running, disconnected` 或警告「Linked but disconnected」。
- 修復：`openclaw doctor`（或重啟 Gateway 閘道器）。若仍持續，請透過 `channels login` 重新連結並檢查 `openclaw logs --follow`。

**Bun 執行環境**

- **不建議** 使用 Bun。WhatsApp（Baileys）與 Telegram 在 Bun 上不穩定。
  請以 **Node** 執行 Gateway 閘道器。（請見 入門指南 的執行環境說明。）
