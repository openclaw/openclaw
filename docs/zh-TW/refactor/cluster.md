---
summary: Refactor clusters with highest LOC reduction potential
read_when:
  - You want to reduce total LOC without changing behavior
  - You are choosing the next dedupe or extraction pass
title: Refactor Cluster Backlog
---

# 重構群組待辦清單

依據可能減少的程式碼行數（LOC）、安全性及涵蓋範圍排序。

## 1. Channel 外掛設定與安全架構

價值最高的群組。

多個 channel 外掛中重複出現的結構：

- `config.listAccountIds`
- `config.resolveAccount`
- `config.defaultAccountId`
- `config.setAccountEnabled`
- `config.deleteAccount`
- `config.describeAccount`
- `security.resolveDmPolicy`

具代表性的範例：

- `extensions/telegram/src/channel.ts`
- `extensions/googlechat/src/channel.ts`
- `extensions/slack/src/channel.ts`
- `extensions/discord/src/channel.ts`
- `extensions/matrix/src/channel.ts`
- `extensions/irc/src/channel.ts`
- `extensions/signal/src/channel.ts`
- `extensions/mattermost/src/channel.ts`

可能的抽取結構：

- `buildChannelConfigAdapter(...)`
- `buildMultiAccountConfigAdapter(...)`
- `buildDmSecurityAdapter(...)`

預期節省：

- 約 250-450 行程式碼

風險：

- 中等。每個 channel 在 `isConfigured`、警告與正規化上略有差異。

## 2. Extension 執行時單例樣板碼

非常安全。

幾乎每個擴充功能都有相同的執行時持有者：

- `let runtime: PluginRuntime | null = null`
- `setXRuntime`
- `getXRuntime`

強力範例：

- `extensions/telegram/src/runtime.ts`
- `extensions/matrix/src/runtime.ts`
- `extensions/slack/src/runtime.ts`
- `extensions/discord/src/runtime.ts`
- `extensions/whatsapp/src/runtime.ts`
- `extensions/imessage/src/runtime.ts`
- `extensions/twitch/src/runtime.ts`

特殊案例變體：

- `extensions/bluebubbles/src/runtime.ts`
- `extensions/line/src/runtime.ts`
- `extensions/synology-chat/src/runtime.ts`

可能的抽取結構：

- `createPluginRuntimeStore<T>(errorMessage)`

預期節省：

- 約180-260 行程式碼

風險：

- 低

## 3. 啟動提示與設定修補步驟

範圍廣泛。

許多入門檔案重複：

- 解析帳號 ID
- 提示允許清單條目
- 合併 allowFrom
- 設定 DM 政策
- 提示秘密資訊
- 修補頂層與帳號範圍設定

強力範例：

- `extensions/bluebubbles/src/onboarding.ts`
- `extensions/googlechat/src/onboarding.ts`
- `extensions/msteams/src/onboarding.ts`
- `extensions/zalo/src/onboarding.ts`
- `extensions/zalouser/src/onboarding.ts`
- `extensions/nextcloud-talk/src/onboarding.ts`
- `extensions/matrix/src/onboarding.ts`
- `extensions/irc/src/onboarding.ts`

現有的輔助接縫：

- `src/channels/plugins/onboarding/helpers.ts`

可能的抽取結構：

- `promptAllowFromList(...)`
- `buildDmPolicyAdapter(...)`
- `applyScopedAccountPatch(...)`
- `promptSecretFields(...)`

預期節省：

- 約 300-600 行程式碼（LOC）

風險：

- 中等。容易過度泛化；請保持輔助函式狹窄且可組合。

## 4. 多帳號 config-schema 片段

擴充功能中重複的 schema 片段。

常見模式：

- `const allowFromEntry = z.union([z.string(), z.number()])`
- 帳號結構擴充：
  - `accounts: z.object({}).catchall(accountSchema).optional()`
  - `defaultAccount: z.string().optional()`
- 重複的 DM/群組欄位
- 重複的 markdown/工具政策欄位

強力範例：

- `extensions/bluebubbles/src/config-schema.ts`
- `extensions/zalo/src/config-schema.ts`
- `extensions/zalouser/src/config-schema.ts`
- `extensions/matrix/src/config-schema.ts`
- `extensions/nostr/src/config-schema.ts`

可能的擷取結構：

- `AllowFromEntrySchema`
- `buildMultiAccountChannelSchema(accountSchema)`
- `buildCommonDmGroupFields(...)`

預期節省：

- 約 120-220 行程式碼

風險：

- 低到中等。有些結構簡單，有些較特殊。

## 5. Webhook 與監控生命週期啟動

良好的中等價值群組。

重複的 `startAccount` / 監控設定模式：

- 解析帳號
- 計算 webhook 路徑
- 紀錄啟動
- 啟動監控
- 等待中止
- 清理
- 狀態匯流排更新

強力範例：

- `extensions/googlechat/src/channel.ts`
- `extensions/bluebubbles/src/channel.ts`
- `extensions/zalo/src/channel.ts`
- `extensions/telegram/src/channel.ts`
- `extensions/nextcloud-talk/src/channel.ts`

現有的輔助接縫：

- `src/plugin-sdk/channel-lifecycle.ts`

可能的抽取形態：

- 用於帳戶監控生命週期的輔助函式
- 用於 webhook 支援的帳戶啟動輔助函式

預期節省：

- 約 150-300 行程式碼

風險：

- 中到高。傳輸細節容易快速分歧。

## 6. 小型完全複製清理

低風險的清理類別。

範例：

- 重複的 gateway argv 偵測：
  - `src/infra/gateway-lock.ts`
  - `src/cli/daemon-cli/lifecycle.ts`
- 重複的 port 診斷呈現：
  - `src/cli/daemon-cli/restart-health.ts`
- 重複的 session-key 建構：
  - `src/web/auto-reply/monitor/broadcast.ts`

預期節省：

- 約 30-60 行程式碼

風險：

- 低

## 測試叢集

### LINE webhook 事件範例資料

強力範例：

- `src/line/bot-handlers.test.ts`

可能的擷取：

- `makeLineEvent(...)`
- `runLineEvent(...)`
- `makeLineAccount(...)`

預期節省：

- 約 120-180 行程式碼

### Telegram 原生指令授權矩陣

強力範例：

- `src/telegram/bot-native-commands.group-auth.test.ts`
- `src/telegram/bot-native-commands.plugin-auth.test.ts`

可能的擷取：

- 論壇上下文建構器
- 拒絕訊息斷言輔助工具
- 表格驅動授權案例

預期節省：

- 約80-140 行程式碼

### Zalo 生命週期設定

強力範例：

- `extensions/zalo/src/monitor.lifecycle.test.ts`

可能的抽取：

- 共享監控設定工具

預期節省：

- 約50-90 行程式碼

### Brave llm-context 不支援選項測試

強力範例：

- `src/agents/tools/web-tools.enabled-defaults.test.ts`

可能的抽取：

- `it.each(...)` 矩陣

預期節省：

- 約30-50 行程式碼

## 建議順序

1. 執行時單例樣板程式碼
2. 小型精確複製清理
3. 設定與安全建構器抽取
4. 測試輔助工具抽取
5. 新手引導步驟抽取
6. 監控生命週期輔助工具抽取
