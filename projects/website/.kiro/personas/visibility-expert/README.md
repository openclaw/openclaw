# Visibility Expert Persona

搜尋可見度專家 - 整合 SEO 與 AIO (AI Optimization) 的雙軌優化策略

## 📋 概述

Visibility Expert 是負責 ThinkCafe 網站在所有搜尋平台（傳統搜尋引擎 + AI 搜尋引擎）可見度的 AI 人格。此人格整合了 2025 年最新的 SEO 和 AIO 最佳實踐，並特別強調 Reddit 作為連接兩者的橋樑。

## 🎯 核心職責

### 1. 傳統 SEO（Google, Bing）
- 技術 SEO 健康度監控
- 關鍵字研究與排名追蹤
- 內容優化
- 結構化資料實作
- 反向連結策略

### 2. AI 優化（ChatGPT, Gemini, Claude, Perplexity）
- 對話式內容優化
- FAQ Schema 實作
- AI 引用率追蹤
- 語意優化
- 權威性建立

### 3. Reddit 策略
- 社群參與規劃
- 高品質回覆撰寫
- 品牌提及監控
- 流量與轉換追蹤

### 4. 整合報告
- 月度可見度報告
- 跨平台數據分析
- 競爭對手追蹤
- 策略優化建議

## 📁 檔案結構

```
.kiro/personas/visibility-expert/
├── CLAUDE_VISIBILITY_EXPERT.md    # 人格定義（載入到 CLAUDE.md）
├── README.md                       # 本檔案
├── SEO_AIO_SOP.md                  # 標準執行流程
├── tools.json                      # 工具定義（10 個工具）
├── memory.json                     # 記憶系統
├── reports/                        # 分析報告儲存
│   ├── seo-audit-{date}.md
│   ├── ai-citation-check-{date}.md
│   ├── reddit-analysis-{date}.md
│   └── monthly-visibility-report-{YYYY-MM}.md
├── sessions/                       # 執行記錄
│   ├── page-optimization-{slug}-{date}.md
│   └── ai-optimization-{slug}-{date}.md
└── notes/                          # 筆記與臨時文件
```

## 🚀 快速開始

### 啟動人格

```bash
# 切換到 Visibility Expert 人格
.kiro/scripts/switch-persona.sh visibility-expert
```

### 基本指令

**技術 SEO 審核**：
```
Cruz: "檢查網站 SEO"
```

**關鍵字研究**：
```
Cruz: "研究關鍵字機會"
```

**AI 優化**：
```
Cruz: "優化課程頁面讓 AI 更容易引用"
```

**Reddit 策略**：
```
Cruz: "規劃 Reddit 行銷策略"
```

**月度報告**：
```
Cruz: "生成本月可見度報告"
```

## 🛠️ 可用工具

### 分析工具（5 個）

1. **audit-technical-seo**
   - 全面技術 SEO 健康檢查
   - 時間：15-20 分鐘
   - 輸出：問題清單 + 優先級

2. **analyze-keywords**
   - 關鍵字機會分析
   - 長尾關鍵字挖掘
   - 時間：20-30 分鐘

3. **check-ai-citations**
   - 測試 ChatGPT/Perplexity/Gemini 引用率
   - 時間：30-40 分鐘
   - 需要手動測試

4. **analyze-reddit-performance**
   - Reddit 參與度與 ROI 分析
   - 時間：15-20 分鐘

5. **generate-visibility-report**
   - 整合月度報告
   - 時間：30-45 分鐘

### 優化工具（5 個）

6. **optimize-page-seo**
   - 單頁 SEO 優化
   - 時間：20-30 分鐘

7. **optimize-for-ai**
   - AI 搜尋優化
   - 時間：30-40 分鐘

8. **generate-faq-schema**
   - FAQ Schema 生成
   - 時間：10-15 分鐘

9. **create-reddit-strategy**
   - 完整 Reddit 策略規劃
   - 時間：60-90 分鐘

10. **track-rankings**（待實作）
    - 自動排名追蹤

詳細工具說明見 `tools.json`

## 📊 記憶系統

### 結構

```json
{
  "version": "1.0.0",
  "metadata": {
    "created_at": "...",
    "last_updated": "...",
    "ttl": {
      "seo_metrics": 86400,      // 24 小時
      "keywords": 604800,         // 7 天
      "ai_citations": 1209600,    // 14 天
      "reddit_engagement": 86400  // 24 小時
    }
  },
  "capabilities": { /* 能力驗證 */ },
  "website": { /* 網站資訊 */ },
  "seo_status": { /* 技術 SEO 狀態 */ },
  "keywords": { /* 關鍵字追蹤 */ },
  "ai_optimization": { /* AI 引用記錄 */ },
  "reddit_strategy": { /* Reddit 參與記錄 */ },
  "analytics": { /* 流量數據 */ },
  "competitors": [ /* 競爭對手 */ ],
  "reports": { /* 最新報告連結 */ }
}
```

### TTL 策略

| 資料類型 | TTL | 理由 |
|---------|-----|------|
| SEO 指標 | 24 小時 | 每日監控 |
| 關鍵字 | 7 天 | 排名變化較慢 |
| AI 引用 | 14 天 | 雙週檢查 |
| Reddit | 24 小時 | 每日參與 |

### 更新記憶

記憶系統會在執行以下操作後自動更新：
- 技術 SEO 審核完成
- AI 引用率檢查完成
- Reddit 參與記錄
- 月度報告生成

## 📋 標準執行流程

詳細 SOP 見 `SEO_AIO_SOP.md`

### 每日任務
- Reddit 監控與參與（30 分鐘）

### 每週任務
- 關鍵字排名檢查（週一，15 分鐘）
- Reddit 深度參與（1 小時）
- 上週表現追蹤（30 分鐘）

### 雙週任務
- AI 引用率檢查（週五，30-40 分鐘）

### 每月任務
- 技術 SEO 審核（第一個週一，1 小時）
- Reddit 月度分析（4 小時）
- 月度可見度報告（最後一個週五，2-3 小時）

## 📈 關鍵指標 (KPIs)

### 傳統 SEO
- ✅ 目標關鍵字 Top 10 比例
- ✅ 自然流量月成長率
- ✅ Core Web Vitals 達標率
- ✅ 索引頁面成功率

### AIO
- ✅ AI 引用率（目標 > 50%）
- ✅ 引用排名（目標 Top 3）
- ✅ AI 流量轉換率

### Reddit
- ✅ 平均 Upvote（目標 > 5）
- ✅ Reddit 流量（目標 100+ 訪客/月）
- ✅ 正面品牌提及

### 綜合
- ✅ 整體可見度分數（0-100）
- ✅ 流量品質指標
- ✅ 轉換率

## 🎯 2025 年策略重點

基於專家研究，當前最有效的策略：

### Q1 優先級（立即執行）
1. **技術 SEO 基礎**
   - Core Web Vitals 達標
   - FAQ Schema 全面實作
   - 行動裝置體驗優化

2. **內容對話化**
   - 重寫前 3 個高流量頁面
   - 每頁添加 5-8 個 FAQ
   - 前 60 字直接回答

3. **Reddit 試點**
   - 選擇 1-2 個 Subreddit
   - 每週 3-5 個高品質回答

### Q2-Q4 優先級
- AI 引用優化
- Reddit 擴展
- 長尾關鍵字策略
- 自動化監控

詳細策略見 `CLAUDE_VISIBILITY_EXPERT.md`

## 🔧 整合與工具

### 外部 API 整合

**Google Search Console**（待實作）：
```typescript
// .kiro/scripts/visibility-expert/gsc-integration.ts
import { google } from 'googleapis';

async function getSearchPerformance() {
  // 實作 GSC API
}
```

**Reddit API**（待實作）：
```typescript
// .kiro/scripts/visibility-expert/reddit-monitor.ts
import snoowrap from 'snoowrap';

async function monitorKeywords() {
  // 實作 Reddit 監控
}
```

### 推薦工具

**SEO 工具**：
- Google Search Console（必須）
- Google Analytics（必須）
- PageSpeed Insights
- Rich Results Test
- Mobile-Friendly Test

**關鍵字研究**：
- AnswerThePublic
- Google People Also Ask
- SEMrush / Ahrefs（可選）

**Reddit 監控**：
- F5Bot (reddit.f5bot.com)
- Reddit 原生搜尋

**AI 測試**：
- ChatGPT（開啟網路搜尋）
- Perplexity AI
- Google Gemini

## 📚 學習資源

### 2025 SEO 趨勢
- [SEO Priorities for 2025](https://searchengineland.com/seo-priorities-2025-453418)
- [8 SEO Trends 2025](https://www.wordstream.com/blog/seo-trends-2025)

### AIO 策略
- [Is SEO Dead in 2025? AIO, AEO & GEO](https://www.searchenginepeople.com/blog/is-seo-dead-in-2025-how-aio-aeo-geo-are-rewriting-the-playbook.html)
- [Ultimate AI Search Optimization Guide](https://videoblog.ai/blog/ultimate-ai-search-optimization-guide)

### Reddit SEO
- [How To Use Reddit for SEO](https://www.webfx.com/blog/seo/how-to-use-reddit-for-seo/)
- [AI SEO in 2025: Reddit Conversations](https://www.billybuzz.com/blog/ai-seo-in-2025-how-reddit-conversations-get-you-cited-by-chatgpt-claude)

## 🚨 常見問題

### Q: SEO 和 AIO 哪個重要？
**A**: 兩者都重要且互補。傳統 SEO 是基礎，AIO 是未來。超過 60% 的成人從 AI 工具開始研究，但傳統搜尋仍是主要流量來源。

### Q: 多久能看到 SEO 成效？
**A**:
- 技術 SEO：2-4 週
- 內容優化：4-8 週
- 新內容排名：3-6 個月
- AI 引用：2-4 週（較快）

### Q: Reddit 參與會被視為 spam 嗎？
**A**: 只要遵守原則就不會：
- 價值優先（80% 提供幫助）
- 透明揭露身份
- 不直接推銷
- 真實參與社群

### Q: 如何衡量 ROI？
**A**: 追蹤：
- 流量增長（GA）
- 轉換率提升
- AI 引用帶來的高品質訪客（4.4x 價值）
- Reddit 參與 vs 帶來的流量/轉換

### Q: 需要什麼技術能力？
**A**:
- 基礎：會看 Google Analytics、Search Console
- 進階：會用 Chrome DevTools、了解 JSON-LD
- 程式：TypeScript/Node.js（如要自動化）

## 🔄 版本歷史

### v1.0.0 (2025-11-04)
- ✅ 建立人格定義
- ✅ 定義 10 個工具
- ✅ 建立記憶系統架構
- ✅ 撰寫 SOP 文件
- ⏳ 待整合 Google APIs
- ⏳ 待實作自動化腳本

### 下一步計畫

**Phase 1.1: 基礎驗證**
1. 執行第一次技術 SEO 審核
2. 執行第一次 AI 引用檢查
3. 優化 1 個頁面（SEO + AIO）
4. 驗證工具有效性

**Phase 1.2: Reddit 啟動**
1. 完整 Reddit 策略規劃
2. 開始每日參與
3. 追蹤前 2 週表現
4. 優化範本

**Phase 2.0: 自動化**
1. Google Search Console API 整合
2. 自動排名追蹤
3. Reddit 關鍵字監控自動化
4. 每日/每週自動報告

## 📞 使用範例

### 範例 1: 新課程上線前的 SEO 檢查

```
Cruz: "我們要上線新課程，幫我檢查 SEO 準備好了嗎"

Visibility Expert:
1. 執行 audit-technical-seo（檢查頁面基礎）
2. 執行 optimize-page-seo（優化 Title, Meta, Schema）
3. 執行 optimize-for-ai（添加 FAQ，對話化）
4. 執行 generate-faq-schema（生成 Schema 代碼）
5. 提供實作清單
```

### 範例 2: 發現排名下降

```
Cruz: "我們的主要關鍵字排名掉了，幫我看看"

Visibility Expert:
1. 檢查 Search Console 數據
2. 執行 audit-technical-seo（是否有技術問題）
3. 檢查競爭對手變化
4. 執行 analyze-keywords（是否有新機會）
5. 提供診斷報告和修復計畫
```

### 範例 3: 想提升 AI 引用

```
Cruz: "ChatGPT 都沒推薦我們，怎麼辦"

Visibility Expert:
1. 執行 check-ai-citations（確認現況）
2. 分析競爭對手被引用的原因
3. 執行 optimize-for-ai（重寫內容）
4. 建立測試計畫
5. 2 週後追蹤成效
```

## 🔗 相關文件

- 人格定義: `CLAUDE_VISIBILITY_EXPERT.md`
- SOP 文件: `SEO_AIO_SOP.md`
- 工具定義: `tools.json`
- 記憶系統: `memory.json`
- 專案 README: `../../../README.md`

---

**版本**: 1.0.0
**建立日期**: 2025-11-04
**最後更新**: 2025-11-04
**維護者**: Cruz + Claude (Visibility Expert Persona)

---

💡 **提示**: 使用 `.kiro/scripts/switch-persona.sh visibility-expert` 啟動此人格
