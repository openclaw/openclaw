# OpenClaw Telegram 交易助手統合定稿（全中文控制面）

> 更新日：2026-05-22  
> 用途：作為 Telegram 交易介面的唯一規格來源（按鈕、回覆、流程、版面、驗收）

---

## 1) 統合後的硬規則（只留可落地）

1. 按鈕回呼資料長度必須在 `1~64 bytes`。
2. 使用者按下按鈕後，必須立即回應回呼查詢（對應 `answerCallbackQuery`），不能讓客戶端持續轉圈。
3. `同意/拒絕` 類按鈕處理完成後，預設清除舊按鈕，避免重複點擊。
4. 交易入口固定採「命令 + 捷徑按鈕」混合模式。
5. 交易流程全程固定四個安全值：
   - `humanApproved=false`
   - `allowLiveTrading=false`
   - `writeBrokerOrders=false`
   - `sentOrder=false`

---

## 2) 統一入口架構（只保留三個）

## 入口 A：`/quote`（交易即時操作）

用途：查價、模擬下單、人工審查、自檢。

按鈕（固定順序）：

1. `🔄 刷新報價` -> `tgcmd:/quote <查詢>`
2. `📡 入口自檢` -> `tgcmd:/quote telegram`
3. `🟢 模擬下單（買）` -> `tgcmd:/quote simlive tx00 buy 1`
4. `🔴 模擬下單（賣）` -> `tgcmd:/quote simlive tx00 sell 1`
5. `🟡 人工審查` -> `tgcmd:/quote semi`
6. `✅ 同意下單` -> `tgcmd:/quote semi approve`
7. `⛔ 拒絕下單` -> `tgcmd:/quote semi reject`
8. `📈 台指近` -> `tgcmd:/quote tx00am`

## 入口 B：`/capital_status`（交易總狀態）

用途：一次查看「報價 / 下單 / 回報 / 查詢」四象限。

按鈕（固定順序）：

1. `🔄 刷新總狀態` -> `tgcmd:/capital_status`
2. `📊 查看報價詳情` -> `tgcmd:/quote status`
3. `🟢 模擬下單（買）` -> `tgcmd:/quote simlive tx00 buy 1`
4. `🟡 人工審查` -> `tgcmd:/quote semi`

## 入口 C：`sc:trade`（SuperClaw 控制面）

用途：多卡片管理（報價、持倉、下單、策略、學習、診斷）。

主按鈕（固定順序）：

1. `📊 報價刷新`（`sc:tr:quote`）
2. `📋 持倉詳情`（`sc:tr:pos`）
3. `📝 模擬下單`（`sc:tr:paper`）
4. `📈 策略狀態`（`sc:tr:strat`）
5. `🔄 學習摘要`（`sc:tr:learn`）
6. `🔍 診斷`（`sc:tr:diag`）
7. `🟡 人工審查`（`sc:tr:semi`）
8. `📊 交易總狀態`（`sc:tr:status`）

---

## 3) 唯一流程（從查價到審查）

1. 使用者進入 `/quote` 或 `sc:trade`。
2. 系統先顯示下單前檢查卡：
   - 報價新鮮度
   - 風控狀態
   - 真單狀態（固定封鎖）
3. 使用者選擇模擬買/賣。
4. 系統產生下單摘要卡（標的、方向、數量、價格、阻擋原因）。
5. 預設導向人工審查（SEMI），不直接執行後續動作。
6. 審查按鈕產生 `capital_semi_(approve|reject|refresh)_<token>`。
7. 回呼處理器消化 token，回寫審查結果，回覆固定結果卡。
8. 回到交易總狀態，給出下一個安全動作。

---

## 4) 下單介面定稿（可用、人性化）

## 面板一：下單前檢查卡

必顯示：

1. `報價狀態：即時 / 過期 / 收盤`
2. `風控狀態：通過 / 阻擋`
3. `真單：封鎖（僅紙上模擬）`

若檢查不通過，只保留：

1. `🔄 刷新報價`
2. `📡 入口自檢`
3. `← 返回`

## 面板二：下單確認卡（兩段）

第一段：選意圖

1. 常用快捷：`TX00 買1`、`TX00 賣1`、`2330 買1`
2. 自訂輸入：手動輸入標的與數量

第二段：送審查

1. `🟡 進入人工審查`
2. `❌ 取消`

## 面板三：人工審查卡（SEMI）

顯示：

1. `標的 / 方向 / 數量`
2. `回呼憑證 token`
3. `四個安全值`

按鈕：

1. `✅ 確認模擬真單`
2. `⛔ 拒絕`
3. `🔄 刷新報價`

## 面板四：審查結果卡（固定格式）

固定欄位：

1. `動作=approve|reject|refresh`
2. `審查清單=已寫入|待寫入`
3. `阻擋原因=...`
4. `下一步=...`

按鈕：

1. `🔄 重新載入審查`
2. `📊 回到總狀態`
3. `← 返回交易`

---

## 5) 回覆文字統一字典（中文優先）

1. `READY` -> `正常`
2. `BLOCKED` -> `阻擋`
3. `stale` -> `過期`
4. `session_closed` -> `收盤時段`
5. `paper-only` -> `僅紙上模擬`
6. `unknown` -> `未知`

固定句尾規格：

1. 報價回覆：`不可回舊價｜真單=封鎖`
2. 下單回覆：`sentOrder=false｜真單=封鎖（僅紙上模擬）`
3. 審查回覆：`真單=封鎖｜sentOrder=false`
4. 總狀態回覆：`下一步=<可執行動作>`

---

## 6) 版面清單（定稿）

1. `L1` 交易首頁（報價/下單/回報/查詢）
2. `L2` 報價面板（主商品 + 新鮮度 + 阻擋）
3. `L3` 下單面板（僅紙上模擬）
4. `L4` 人工審查面板
5. `L5` 審查回呼結果面板
6. `L6` 交易總狀態面板（對齊 `/capital_status`）

---

## 7) 缺口比對（目前未完成）

1. `sc:tr:semi` 與 `sc:tr:status` 需完成完整卡片回流。
2. 下單快捷（TX00/2330）需補可配置數量。
3. 審查回呼需補完整測試（approve/reject/refresh）。
4. `/quote` 與 `sc:trade` 需統一同一套文案字典。
5. 總狀態卡需固定輸出「下一步安全動作」。

---

## 8) 一次性製作清單（只留最實用）

## P0（先做可用閉環）

1. `sc:trade` 補齊「人工審查」與「交易總狀態」入口。
2. 補齊 `sc:tr:semi` -> 顯示人工審查卡（L4）。
3. 補齊 `sc:tr:semi-result` -> 顯示回呼結果卡（L5）。
4. 統一交易回覆字典為全中文。

## P1（再補操作效率）

1. 下單快捷按鈕（TX00/2330 + 常用數量）。
2. 一鍵刷新串接（quote + capital_status + semi 狀態）。
3. 新增最近一次交易閉環摘要卡。

## P2（再補穩定性）

1. 回呼 token 測試（approve/reject/refresh）。
2. 中文回覆一致性測試。
3. 交易首頁按鈕路由測試。

---

## 9) 實作對照檔案（直接改這些）

1. `extensions/telegram/src/bot-native-commands.ts`
2. `extensions/telegram/src/bot-handlers.runtime.ts`
3. `extensions/automation/src/telegram-ui/trading-panel.ts`
4. `extensions/automation/src/telegram-ui/callback-router.ts`
5. `scripts/openclaw-capital-quote-telegram-reply.mjs`
6. `scripts/openclaw-capital-telegram-semi-approval-gate.mjs`
7. `scripts/openclaw-capital-telegram-semi-approval-callback.mjs`

---

## 10) 驗收標準（達標才算完成）

1. 所有交易按鈕與回覆都可全中文閱讀。
2. 任一流程都不會開真單（四個安全值全程成立）。
3. 人工審查從按鈕到回呼寫入形成完整閉環。
4. `/quote` 與 `sc:trade` 的操作心智一致。
5. 任一畫面都可返回上一層，不會卡死。

---

## 11) 統合依據（官方 + 開源）

1. Telegram Bot API（回呼資料長度、回呼回應要求）：  
   [https://core.telegram.org/bots/api](https://core.telegram.org/bots/api)
2. Freqtrade Telegram 使用與通知分層（開源交易機器人操作面）：  
   [https://docs.freqtrade.io/en/latest/telegram-usage/](https://docs.freqtrade.io/en/latest/telegram-usage/)
3. grammY Inline Keyboard 與 callback data 實務：  
   [https://grammy.dev/plugins/keyboard](https://grammy.dev/plugins/keyboard)  
   [https://grammy.dev/ref/types/inlinekeyboardbutton/callbackbutton](https://grammy.dev/ref/types/inlinekeyboardbutton/callbackbutton)
