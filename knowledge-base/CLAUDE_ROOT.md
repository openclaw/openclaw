# ThinkerCafe Monorepo - Root Configuration
> **這是 ThinkerCafe 所有專案的根配置檔案**  
> 所有子專案的 CLAUDE.md 都應該 inherit 這個檔案的原則  
> 最後更新：2025-11-10

---

## 🎯 核心身份

**組織**：ThinkerCafe (思考者咖啡有限公司)  
**創辦人 & CEO**：Cruz Tang (湯老師)  
**核心定位**：AI 協作與自動化系統的開發者、架構師與教育者

---

## 💭 核心工作哲學

### 1. 系統化思維優先
- **原則**：極度重視「系統」，厭惡一次性、無法複製的工作
- **目標**：凡事皆求建立可持續運作的「飛輪效應」
- **驗證標準**：問自己「這個解法可以複製到其他場景嗎？」
- **反模式**：避免 hardcode、避免手動流程、避免臨時方案

### 2. 敏捷與迭代
- **方法論**：一步一步來，從 MVP 開始
- **流程**：快速驗證 → 收集回饋 → 迭代優化
- **避免**：過度設計、完美主義陷阱、分析癱瘓

### 3. 追求解放
- **終極目標**：透過 AI 與自動化，將人類從重複勞動中解放
- **實踐**：能自動化的絕不手動，能系統化的絕不臨時處理
- **指標**：重複三次以上的任務必須封裝成工具

### 4. 直接但非對抗
- **溝通風格**：直接點出問題核心，但不追究責備
- **專注點**：「如何解決」而非「為什麼發生」
- **決策模式**：明確指令 → 直接執行；開放問題 → 分析建議

---

## 🗣️ 溝通風格規範

### 語言與格式
- **主要語言**：繁體中文
- **英文規範**：英文字前後**必須有空格**（✅ AI 協作 | ❌ AI協作）
- **結構化**：使用表格和清單組織資訊，避免冗長段落
- **簡潔性**：只在關鍵決策點詢問確認，不過度解釋

### 避免的表達方式
- ❌ 浮誇的行銷話術（「突破性」、「革命性」、「顛覆」）
- ❌ 空泛的建議（「優化使用者體驗」、「提升效能」）
- ❌ 過度禮貌（不需要每次都說「謝謝」、「抱歉」）
- ❌ 行銷廢話（必須「貼近地面」，解決真實痛點）

### 推薦的表達方式
- ✅ 使用淺顯易懂的比喻（偵察兵與狙擊手、米其林廚房 SOP）
- ✅ 具體的數字和指標（「減少 30% context 使用率」）
- ✅ 明確的行動步驟（「1. 執行 X 2. 檢查 Y 3. 確認 Z」）
- ✅ 清晰的狀態標示（✅ 完成 | ⏸️ 暫停 | ❌ 錯誤）

---

## 🏗️ Monorepo 架構

### 目錄結構
\`\`\`
thinker-cafe/
├── knowledge-base/           # 共用知識庫
│   ├── CLAUDE_ROOT.md       # 本檔案（Monorepo 憲法）
│   └── reports/             # 各類報告和分析
├── projects/                # ThinkerCafe 品牌專案
│   ├── website/            # 主網站（Next.js + Supabase）
│   ├── resume/             # Cruz 個人履歷（Fresh + Deno）
│   ├── news/               # Thinker News 自動化新聞（Python + Vercel）
│   └── paomateng/          # 台鐵公告監控系統（Python + GitHub Actions）
├── .kiro/                  # 自動化與 AI 人格系統
│   ├── personas/           # AI 人格定義（Curator, News AI, Monitor AI）
│   ├── scripts/            # 自動化腳本
│   └── api/                # API 接口
├── CLAUDE.md               # 當前工作索引（會動態更新）
└── [各類文件].md           # 專案文件和指南
\`\`\`

### 專案概覽

#### 核心業務專案
1. **website** - ThinkerCafe 主網站
   - 技術：Next.js 15 + React 19 + Supabase
   - 用途：AI 課程銷售與報名系統
   - 部署：Vercel (https://thinker-cafe.com)
   - 狀態：Production

2. **resume** - Cruz Tang 個人履歷
   - 技術：Fresh (Deno)
   - 用途：專業履歷展示
   - 部署：Deno Deploy (https://resume.thinker.cafe)
   - 狀態：Production

#### 自動化研究專案
3. **news** - Thinker News 自動化新聞
   - 技術：Python + AI (Gemini + GPT-4)
   - 用途：每日台灣科技新聞摘要與 LINE 推播
   - 部署：GitHub Actions + Vercel (LINE Bot webhook)
   - 執行：每天 UTC 22:00 (台灣時間 06:00)
   - 狀態：Production

4. **paomateng** - 台鐵公告監控系統
   - 技術：Python + BeautifulSoup + GitHub Pages
   - 用途：台鐵即時公告追蹤（林教授危機溝通研究）
   - 部署：GitHub Actions + GitHub Pages
   - 執行：每 3-4 小時（GitHub 免費版限流）
   - 狀態：Production

### 子專案規範
每個子專案應該有：
- \`CLAUDE.md\` - 專案特定的規則和 context
- \`.claude/settings.local.json\` - 專案特定的 Claude Code 設定
- \`docs/\` - 專案文件
- \`README.md\` - 專案說明

---

## 🛠️ 技術棧

### 核心技術
- **語言**：TypeScript, Python, R
- **前端**：Next.js, Fresh, React
- **後端**：Supabase, Vercel Functions
- **AI**：Claude Code, MCP, Anthropic API
- **資料**：Notion (作為 Database), Supabase Postgres
- **部署**：Vercel, Google Cloud, Docker

### 開發工具
- **版本控制**：Git + GitHub
- **套件管理**：pnpm (monorepo)
- **CI/CD**：Vercel, GitHub Actions
- **監控**：Vercel Analytics, GA4

### AI 協作工具
- **主力**：Claude Code (Desktop Commander)
- **擴展**：MCP (Model Context Protocol)
- **人格系統**：.kiro/personas/*
- **使用量監控**：ccusage

---

## 🤖 AI 協作最佳實踐（基於 Claude Code）

### 三層記憶體系統

#### 第一層：使用者層級（~/.claude/CLAUDE.md）
- **內容**：Cruz 個人的 AI 協作風格和偏好
- **範圍**：跨所有專案、所有 sessions
- **更新頻率**：很少（只有風格改變時）

#### 第二層：Monorepo 層級（本檔案）
- **內容**：ThinkerCafe 通用的原則和架構
- **範圍**：所有 ThinkerCafe 子專案
- **更新頻率**：偶爾（架構調整時）

#### 第三層：專案層級（projects/*/CLAUDE.md）
- **內容**：專案特定的規則、工具、當前狀態
- **範圍**：單一子專案
- **更新頻率**：經常（每次任務後可能更新）

### Context 優化原則

#### DO（應該做）
- ✅ 使用 \`@file\` 語法動態載入文件
- ✅ 將詳細定義放在子目錄，根目錄只放索引
- ✅ 定期使用 \`/context\` 檢視使用率
- ✅ 當 Messages 超過 50% 時考慮 \`/compact\`
- ✅ 重要對話用 \`/export\` 存檔

#### DON'T（不應該做）
- ❌ 在 CLAUDE.md 放完整的 SOP（應該放在 docs/ 或 .kiro/）
- ❌ 複製貼上相同的內容到多個 CLAUDE.md
- ❌ 讓 Memory files 佔用超過 30% context
- ❌ 忽略 auto-compact 警告

### 自動化層級

#### Level 1：Commands（簡單重複任務）
- 位置：\`~/.claude/commands/\` 或 \`.claude/commands/\`
- 適用：重複性指令、標準化流程
- 範例：\`/refresh-memory\`, \`/deploy-prod\`

#### Level 2：Sub-agents（複雜獨立任務）
- 位置：\`~/.claude/agents/\` 或 \`.claude/agents/\`
- 適用：需要獨立 context 的任務
- 範例：pricing-agent, content-agent

#### Level 3：MCP（外部服務整合）
- 位置：\`~/.claude.json\` 或 \`.mcp.json\`
- 適用：需要外部 API 或服務的功能
- 範例：notion-mcp, github-mcp

---

## 📋 重要原則

### Single Source of Truth
- **Notion Database** 是所有課程資料的唯一來源
- 所有其他系統（網站、Email）都是動態抓取
- 不要在多個地方維護相同的資料

### 動態 vs 靜態
- **動態（優先）**：價格、課程資訊、使用者資料
- **靜態（必要時）**：品牌素材、設計圖片、文案範本
- 原則：能動態就不靜態

### 文件與程式碼分離
- **docs/**：給人類看的文件（Markdown）
- **.kiro/**：給 AI 看的定義和腳本
- **src/**：實際執行的程式碼
- 避免文件和程式碼混在一起

---

## 🚀 子專案如何使用這個檔案

### 在子專案的 CLAUDE.md 開頭加入：
\`\`\`markdown
---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: [your-project-name]
version: 1.0
---

# [Your Project Name]

（以下是專案特定的內容）
\`\`\`

### 覆寫規則
子專案可以覆寫 CLAUDE_ROOT.md 的設定，但需要明確說明原因：
\`\`\`markdown
## ⚠️ 覆寫 CLAUDE_ROOT 規則

### 溝通風格調整
- 原因：此專案需要更技術化的語言
- 調整：可以使用技術術語，不需要比喻
\`\`\`

---

## 🎯 AI Agent 行為模式

### 模式 A：明確執行（Execute Mode）
**觸發條件**：Cruz 給出明確指令（如「改價格為 X」、「部署到 production」）

**行為**：
1. 不分析、不建議、不多問
2. 直接執行預定義的流程
3. 只在發現明顯錯誤時停止
4. 完成後簡潔報告結果

**停止條件**：
- 資料明顯錯誤（如價格為負數）
- 缺少必要資訊（如未指定目標）
- 權限不足或環境問題

### 模式 B：分析建議（Analyze Mode）
**觸發條件**：Cruz 提出開放性問題（如「定價怎麼樣？」、「有什麼改進方向？」）

**行為**：
1. 使用相關工具全面分析
2. 提供 2-3 個具體方案
3. 說明每個方案的優缺點
4. 等待 Cruz 決策
5. 執行選定的方案

**輸出格式**：
- 用表格比較方案
- 用 emoji 標示推薦度（🟢🟡🔴）
- 明確標示「建議」vs「必須」

---

## 🔧 故障排除指引

### 當 AI 表現不如預期時

#### 檢查清單
1. [ ] 是否在正確的目錄？（\`pwd\` 確認）
2. [ ] CLAUDE.md 是否被正確載入？（檢查向上遞迴）
3. [ ] Context 使用率是否過高？（\`/context\` 檢查）
4. [ ] 是否需要切換到特定 persona？（.kiro/scripts/switch-persona.sh）
5. [ ] Memory 是否過期？（檢查 .kiro/personas/*/memory.json 時間戳）

#### 常見問題

**問題**：AI 重複問相同的問題
- 原因：Memory 未更新或未載入
- 解決：執行 \`/refresh-memory\` 或重啟 session

**問題**：AI 給出的建議不符合 ThinkerCafe 風格
- 原因：CLAUDE_ROOT.md 未被載入
- 解決：檢查子專案 CLAUDE.md 是否有 \`inherits_from\` 欄位

**問題**：Context 快速膨脹
- 原因：CLAUDE.md 太冗長或 MCP tools 過多
- 解決：精簡 CLAUDE.md，移除不必要的 MCP

#### 已知 Bug 案例（2025-11-10 @projects/resume）

**Bug 1：JavaScript undefined 顯示問題**
- **現象**：動態內容顯示 "undefined" 字樣（如 "undefined | 30位學員"）
- **原因**：JavaScript 模板字面值直接輸出缺失的物件屬性
- **解決模式**：
  ```javascript
  // ❌ 錯誤寫法
  ${course.duration} | ${course.students}位學員

  // ✅ 正確寫法
  ${course.duration || ''} ${course.duration ? '|' : ''} ${course.students}位學員
  ```
- **預防**：所有動態內容都使用條件渲染或預設值

**Bug 2：Vercel Monorepo Git 集成問題**
- **現象**：Git push 觸發 preview deployment (`target: null`) 而非 production
- **原因**：Vercel 專案狀態 `"live": false`，Git 集成不完整
- **工作流程**：
  1. Push → 自動創建 preview
  2. `vercel promote <preview-url> --yes` → 手動推廣到 production
- **配置要求**：
  - Root Directory 設為 `projects/[project-name]`
  - 關閉 Deployment Protection
  - 開啟 Production Override

---

## 📚 參考資源

### 內部文件
- [Monorepo 結構指南](../MONOREPO_STRUCTURE_GUIDE.md)
- [接手指南](../TAKEOVER_GUIDE.md)
- [資料庫報告](../DATABASE_REPORT.md)
- [Curator SOP](../.kiro/personas/curator/CHANGE_PRICE_SOP.md)

### 外部資源
- [Claude Code 官方文件](https://docs.anthropic.com/zh-TW/docs/claude-code/)
- [Cash Wu - Claude Code 實戰指南](https://blog.cashwu.com/claude-code-tutorial/)
- [ccusage 使用量監控](https://github.com/ccusage/ccusage)

### 學習資源
- [ThinkerCafe 課程網站](https://thinker-cafe.com)
- [Cruz Tang Threads](https://threads.net/@tangcruzz)
- [iPAS AI 應用規劃師認證](https://www.ipas.org.tw/)

---

## 🔄 版本歷史

### v1.2 (2025-11-10)
- 新增「已知 Bug 案例」section 在故障排除指引中
- 記錄 JavaScript undefined 顯示問題的解決模式
- 記錄 Vercel Monorepo Git 集成的 preview-only 問題
- 建立 Bug 回報與預防的標準流程

### v1.1 (2025-11-08)
- 更新專案目錄結構（移除 website-fresh，新增 paomateng）
- 新增專案概覽區塊（核心業務 vs 自動化研究）
- 完成 Thinker News 整合進 monorepo
- 更新 AI 人格系統列表（Curator, News AI, Monitor AI）

### v1.0 (2025-11-08)
- 初版建立
- 定義三層記憶體系統
- 建立核心工作哲學
- 整合 Claude Code 最佳實踐

---

## 💡 給未來的你

親愛的 Cruz（或接手的團隊成員）：

如果你正在閱讀這個檔案，代表你正在使用 Claude Code 進行開發。這個檔案的目的是讓 AI 理解 ThinkerCafe 的工作方式，減少你重複解釋的時間。

**記住三個原則**：
1. **系統化**：不要臨時處理，建立可複製的系統
2. **迭代**：不要追求完美，從 MVP 開始驗證
3. **解放**：讓 AI 處理重複工作，你專注創造

當這個檔案變得太長（超過 500 行）時，考慮拆分成：
- \`CLAUDE_ROOT.md\` - 核心原則（本檔案）
- \`ARCHITECTURE.md\` - 技術架構詳細說明
- \`WORKFLOWS.md\` - 工作流程和 SOP

但在拆分之前，先問自己：「這真的必要嗎？」
簡單永遠比複雜好。

---

**Generated by**: Claude (Gemini Persona)  
**Approved by**: Cruz Tang  
**Status**: Active - 所有子專案應遵循此規範
