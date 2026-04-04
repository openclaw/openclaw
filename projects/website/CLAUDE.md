---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: website
persona: Curator
project_type: production_website
last_updated: 2025-11-08
---

# ThinkerCafe Website - 課程網站專案

> 主網站專案配置檔案
> 繼承 ThinkerCafe 核心原則，專注於 website 特定規則

---

## 🎯 專案身份

### 核心定位
- **專案名稱**: ThinkerCafe Website
- **用途**: AI 課程銷售與報名系統
- **技術棧**: Next.js 15.2.4 + React 19 + TypeScript + Supabase
- **部署**: Vercel (https://thinker-cafe.com)
- **環境**: Production

### 與其他專案的關係
- **資料來源**: Notion Database (課程資料的 Single Source of Truth)
- **後端**: Supabase (使用者、訂單、禮包資料)
- **新聞整合**: projects/news (可在首頁顯示最新新聞)
- **Curator 系統**: .kiro/personas/curator/ (課程內容管理)

---

## 🏗️ 系統架構

### 資料流程
```
Notion Database (課程資料)
  ↓ (60秒 revalidate)
Website API Routes (/api/notion-data)
  ↓
前端頁面 (SSR/ISR)
  ├─ 首頁 (/)
  ├─ 課程列表 (/products)
  ├─ 課程詳情 (/products/[id])
  ├─ 購買流程 (/buy-course/[courseId])
  └─ 訂單確認 (/order/[orderId])

Supabase (使用者 & 訂單資料)
  ↓
API Routes
  ├─ /api/orders (訂單 CRUD)
  ├─ /api/packages (禮包 CRUD)
  └─ /api/auth/* (認證)
```

### 核心技術
- **框架**: Next.js 15.2.4 (App Router)
- **語言**: TypeScript 5.x
- **樣式**: Tailwind CSS
- **UI 組件**: shadcn/ui
- **資料庫**: Supabase Postgres
- **認證**: Supabase Auth
- **部署**: Vercel
- **分析**: Google Analytics 4

---

## 🤖 AI 人格模式

### 當前人格: Curator

**完整定義**: @../../.kiro/personas/curator/README.md

**在 Website 專案中的角色**:
- 管理課程的視覺內容（圖片、影片）
- 更新課程定價（同步到 Notion）
- 確保網站顯示與 Notion 一致
- 優化課程頁面的視覺呈現

**可用工具**: @../../.kiro/personas/curator/tools.json

**價格更新流程**: @../../.kiro/personas/curator/CHANGE_PRICE_SOP.md

---

## 📋 Website 特定規則

### 1. 資料來源優先級

**課程資料**:
- ✅ **優先**: Notion Database (`26405e9de12180ff9e11e4b93209d16b`)
- ❌ **禁止**: 硬編碼在組件中

**價格顯示**:
- ✅ 使用 `group_price_early` (早鳥價) 優先
- ✅ Fallback 到 `group_price` (團班價)
- ✅ Fallback 到 `single_price_early` (一對一早鳥)
- ✅ Fallback 到 `single_price` (一對一價格)
- ❌ 禁止使用 hardcoded fallback 值

**環境變數**:
- ✅ **必須**: `NEXT_PUBLIC_GA_MEASUREMENT_ID` (GA4)
- ✅ **必須**: `NOTION_API_KEY` (Notion API)
- ✅ **必須**: Supabase 相關環境變數
- ❌ **禁止**: 在程式碼中 hardcode 任何 credentials

### 2. 錯誤處理規範

- ✅ 使用 `app/error.tsx` 處理頁面錯誤
- ✅ 使用 `app/global-error.tsx` 處理全域錯誤
- ✅ 使用 `app/not-found.tsx` 處理 404
- ✅ 所有錯誤頁面必須是 Client Component (`'use client'`)
- ✅ 提供「重試」和「返回首頁」按鈕

### 3. 課程頁面設計規範

**必須包含的區塊** (按順序):
1. Hero Section (主視覺 + 價格 + CTA)
2. Bar Section (課程重點資訊)
3. Content Highlights (3 個內容亮點)
4. CourseInfo (課程資訊：時間、地點、講師)
5. FAQ (常見問題)
6. Footer CTA (最終 Call-to-Action)

**CourseInfo 組件規則**:
- ✅ 價格必須從 props 傳入（來自 Notion API）
- ✅ 支援早鳥價顯示
- ✅ 顯示課程時間、地點、講師資訊
- ❌ 不可 hardcode 任何課程特定資訊

### 4. Build 與部署規範

**已知問題（可忽略）**:
- ⚠️ Next.js 15 + React 19 在 /404 和 /500 預渲染時有 warning
- 原因: Next.js 內部 Pages Router 不兼容 React 19
- 狀態: 不影響運行，等待官方修復
- 解決方案: 已建立自定義錯誤頁面

**Build 檢查清單**:
- [ ] `pnpm build` 成功完成
- [ ] TypeScript 檢查通過（目前設定 `ignoreBuildErrors: true`）
- [ ] ESLint 檢查通過（目前設定 `ignoreDuringBuilds: true`）
- [ ] 環境變數正確設定

---

## 🔄 工作流程

### 修改課程價格
1. 使用 Curator 工具: `update-course-pricing`
2. 或手動執行 SOP: @../../.kiro/personas/curator/CHANGE_PRICE_SOP.md
3. 驗證網站更新（等待 60 秒 revalidate）

### 新增課程頁面
1. 在 Notion Database 建立新課程
2. 設定所有必要欄位（價格、圖片、描述）
3. 網站會自動抓取（60 秒內）
4. 檢查 `/products/[新課程ID]` 是否正常顯示

### 修改視覺內容
1. 更新 Notion 中的圖片
2. 使用 Curator 工具上傳新圖片
3. 刷新 Curator Memory: `pnpm tsx ../../.kiro/scripts/curator/build-memory-v1.5.ts`

---

## 📊 當前狀態

### 最近更新 (2025-11-08)

**Bug 修復**:
- ✅ 新增錯誤處理頁面 (error.tsx, global-error.tsx, not-found.tsx)
- ✅ 修復 CourseInfo 價格 hardcode (Issue #8)
- ✅ 移除 GA ID hardcode fallback (Issue #9)

**文檔**:
- ✅ 產出完整流程分析: `website_flow_20251108.md`
- ✅ 記錄 11 個 bugs/issues

### 待處理事項

**中優先級**:
- Issue #7: 實作訂單列表頁 (`/orders`)
  - 位置: `app/orders/page.tsx`
  - 功能: 顯示使用者所有訂單

**低優先級**:
- Issue #4: 課程日期 hardcode
  - 建議: 改為從 Notion 動態抓取
- Issue #5: 探索者獎勵邏輯僅針對課程 6
  - 建議: 擴展到其他課程或移除

---

## 🗂️ 重要檔案位置

### 專案核心
- 完整流程分析: `website_flow_20251108.md`
- 環境變數範例: `.env.example`
- Next.js 配置: `next.config.ts`
- TypeScript 配置: `tsconfig.json`
- Tailwind 配置: `tailwind.config.ts`

### 頁面與組件
- 首頁: `app/page.tsx`
- 課程列表: `app/products/page.tsx`
- 課程詳情: `app/products/[id]/page.tsx`
- 購買流程: `app/buy-course/[courseId]/page.tsx`
- 訂單確認: `app/order/[orderId]/page.tsx`

### API Routes
- Notion 資料: `app/api/notion-data/route.ts`
- 訂單 API: `app/api/orders/route.ts`
- 禮包 API: `app/api/packages/route.ts`

### 錯誤處理
- 頁面錯誤: `app/error.tsx`
- 全域錯誤: `app/global-error.tsx`
- 404 頁面: `app/not-found.tsx`

---

## 🔧 常用指令

### 開發
```bash
pnpm install        # 安裝依賴
pnpm dev           # 啟動開發伺服器 (localhost:3000)
pnpm build         # 建置生產版本
pnpm start         # 啟動生產伺服器
pnpm lint          # ESLint 檢查
```

### Curator 操作
```bash
# 刷新課程記憶
pnpm tsx ../../.kiro/scripts/curator/build-memory-v1.5.ts

# 檢查記憶時效性
pnpm tsx ../../.kiro/scripts/curator/check-memory-freshness.ts
```

### 環境變數管理
```bash
# 從 Vercel 拉取環境變數
vercel env pull .env.local

# 連結到 Vercel 專案
vercel link --yes
```

---

## 🐛 已知問題與解決方案

### Build Warning: /404 和 /500 預渲染
**問題**: Next.js 15 + React 19 不兼容導致的 warning
**影響**: 僅 build 時出現，不影響運行
**解決方案**: 已建立自定義錯誤頁面，等待官方修復

### TypeScript 檢查被跳過
**問題**: `next.config.ts` 中設定 `ignoreBuildErrors: true`
**原因**: 加速 build，但可能隱藏型別錯誤
**建議**: 定期執行 `tsc --noEmit` 檢查型別

### Notion API Rate Limit
**問題**: 每秒最多 3 requests
**解決方案**: 使用 60 秒 revalidate，減少 API 呼叫
**監控**: 檢查 Notion API 使用量

---

## 💡 維護建議

### 定期檢查
- [ ] 每週檢查 Notion API 是否正常
- [ ] 每月檢查 Supabase 資料庫大小
- [ ] 每月檢查 Vercel Analytics 數據
- [ ] 每季檢查依賴更新 (`pnpm outdated`)

### 性能監控
- [ ] 使用 Vercel Analytics 追蹤頁面效能
- [ ] 檢查 Core Web Vitals (LCP, FID, CLS)
- [ ] 監控 API response time
- [ ] 檢查圖片載入速度

### 安全性
- [ ] 定期更新依賴 (`pnpm update`)
- [ ] 檢查環境變數是否外洩
- [ ] 驗證 Supabase RLS policies
- [ ] 審查 API routes 的權限控制

---

## 📞 協作風格

### 在 Website 專案中工作時

**DO（應該做）**:
- ✅ 先閱讀 `website_flow_20251108.md` 了解全貌
- ✅ 修改前先備份重要檔案
- ✅ 使用 Curator 工具而非手動修改 Notion
- ✅ 測試所有變更（dev + build）
- ✅ 記錄重大變更在專案文檔中

**DON'T（不應該做）**:
- ❌ 不要 hardcode 任何課程資料
- ❌ 不要跳過環境變數檢查
- ❌ 不要忽略 TypeScript 錯誤
- ❌ 不要直接修改 Notion（使用 Curator）
- ❌ 不要在未測試時部署到 production

---

## 🔗 相關文件

### 專案內
- 流程分析: `website_flow_20251108.md`
- README: `README.md`

### Monorepo 層級
- 核心憲法: `../../knowledge-base/CLAUDE_ROOT.md`
- Curator 定義: `../../.kiro/personas/curator/README.md`
- Curator SOP: `../../.kiro/personas/curator/CHANGE_PRICE_SOP.md`

### 外部資源
- [Next.js 15 文檔](https://nextjs.org/docs)
- [Supabase 文檔](https://supabase.com/docs)
- [Notion API 文檔](https://developers.notion.com/)

---

**Generated by**: Claude Code
**Last Updated**: 2025-11-08
**Maintainer**: Cruz Tang
**Status**: Production - Active
