/**
 * trading-copy.ts — 交易介面共用文案
 *
 * 集中管理交易面板 / callback 回覆的共用按鈕文字，
 * 避免同義文案分散造成 UI 不一致。
 */

export const TRADING_BUTTON_COPY = {
  refresh: "🔄 刷新",
  backToTrade: "← 返回交易",
  backToOrder: "← 返回下單",
  confirmClose: "✅ 確認平倉",
  diagnose: "🔍 診斷",
  quoteRefresh: "📊 刷新報價",
  coreProductQuotes: "📊 全商品報價",
  positionDetail: "📋 持倉詳情",
  aiPlatform: "🧠 AI 交易平台",
  paperOrder: "📝 模擬下單",
  strategyStatus: "📈 策略狀態",
  learningSummary: "🔄 學習摘要",
  hftGates: "⚡ 高頻閘門",
  dispatcherCheck: "🧭 下單串接",
  capitalStatus: "🧭 交易總覽",
  okxStatus: "🟦 OKX 狀態",
  okxReadinessRefresh: "🔁 OKX 刷新",
  okxOrderProposal: "🧾 OKX 提案",
  okxOrderStatus: "📋 OKX 訂單",
  liveBlockers: "🛡 實單阻擋",
  directOperate: "🚦 直接操作",
  localExecutor: "🧩 本地執行器",
  liveExecutorArmProfile: "🔐 實單 Arm",
  directRun: "🔁 重跑直接Gate",
  directPositionRefresh: "📋 重讀倉位Gate",
  adapterApplyReceipt: "📥 Ack套用收據",
  receiptGate: "🧾 回關收據",
  paperAssistant: "🤖 模擬助手",
  tradeAutoCycle: "🔁 交易總循環",
  writeFastTicket: "✍️ 寫入審核票",
  approvePaper: "✅ 核准模擬執行",
  paperReviewLoop: "✅ 一鍵模擬閉環",
  denyFastTicket: "❌ 拒絕審核票",
  auditTrail: "🧾 審核紀錄",
  rerunChecks: "🔁 重跑檢查",
  buy: "🔺 買入",
  sell: "🔻 賣出",
  closeAll: "⏹ 全部平倉",
  home: "← 首頁",
} as const;
