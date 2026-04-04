---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: resume
project_type: personal_website
last_updated: 2025-11-10
---

# Cruz Tang Resume - 個人履歷網站

> Cruz Tang 的線上履歷網站專案
> 繼承 ThinkerCafe 核心原則，專注於個人品牌展示

---

## 🎯 專案概述

**專案目的**：展示 Cruz Tang 的專業背景、技能與經歷

**主要功能**：
- 雙版本切換（個人版 / 企業版）
- 響應式設計
- 互動式技能展示
- 線上聯絡表單
- 自動備份系統

**目標使用者**：招聘者、潛在客戶、合作夥伴

---

## 🏗️ 技術架構

### 技術棧
- **前端**：純 HTML + CSS + JavaScript (無框架)
- **部署**：Vercel (https://cruz-resume.vercel.app)
- **資料管理**：JSON 檔案 + 自動備份
- **版本控制**：Git

### 資料流
```
data.json (本地資料)
    ↓
JavaScript 動態載入
    ↓
DOM 渲染 (個人版/企業版)
    ↓
自動備份 (每次修改後)
```

### 關鍵設計決策
- **無框架設計**：保持輕量、快速載入
- **雙版本系統**：個人版（完整）vs 企業版（精簡）
- **JSON 驅動**：所有內容從 data.json 動態生成

---

## 📁 專案結構

```
resume/
├── data/
│   ├── backups/           # 自動備份的 JSON 檔案
│   └── (data.json)        # 主資料檔案（gitignored）
├── docs/
│   └── ANALYSIS_REPORT.md # 企業版頁面空白問題分析
├── .vercel/               # Vercel 部署配置
└── CLAUDE.md             # 本檔案
```

**注意**: 實際的履歷檔案（HTML, CSS, JS）可能在 Vercel 部署的專案根目錄

---

## 🔧 開發設定

### 環境變數
```bash
# Vercel 專案配置（在 .vercel/project.json）
PROJECT_ID=prj_5Y02CJUnx2uXbYieAMLfX3yPQ0u0
ORG_ID=team_hAZyiJJoplXyhxRiU5XhScAK
PROJECT_NAME=cruz-resume
```

### 部署指令
```bash
# 連結 Vercel 專案
vercel link --yes

# 本地預覽
vercel dev

# 自動部署（preview）
git add . && git commit -m "message" && git push

# 手動推廣到 production
vercel promote <preview-url> --yes
```

---

## 🎯 當前狀態

### 專案階段
- [x] 已上線

### 最近更新 (2025-11-10)
- ✅ 修復教學部分 undefined 顯示問題
- ✅ 配置 Vercel monorepo Git 自動部署
- ✅ 建立手動 promote 工作流程

### 已知問題（已修復）
- ~~企業版頁面空白問題~~ (已修復，詳見 `docs/ANALYSIS_REPORT.md`)
  - 原因：版本切換邏輯和 CSS 問題
  - 修復：添加 version-personal class + 調整 padding

- ~~教學部分 undefined 顯示問題~~ (已修復，2025-11-10)
  - **問題**：教學經歷中的課程顯示 "undefined | 30位學員"
  - **原因**：`course.duration` 欄位缺失但 JavaScript 直接輸出 `${course.duration}`
  - **修復**：改為 `${course.duration || ''} ${course.duration ? '|' : ''}` 條件渲染
  - **位置**：`index.html:692` 行

- ~~Vercel 自動部署配置問題~~ (已修復，2025-11-10)
  - **問題**：Git push 觸發 preview deployment (`target: null`) 而非 production
  - **原因**：Vercel 專案狀態 `"live": false`，Git 集成不完整
  - **工作流程**：Push → 自動創建 preview → 手動 `vercel promote <url> --yes` → production
  - **配置**：Root Directory 設為 `projects/resume`，關閉 Deployment Protection

---

## 📋 Resume 特定規則

### 1. 雙版本系統

**個人版** (Personal Version):
- 完整的個人資訊
- 興趣、愛好、個人照片
- 適合：創業、自由工作、個人品牌

**企業版** (Corporate Version):
- 精簡的專業資訊
- 只保留工作相關內容
- 適合：應徵企業職位

**切換邏輯**:
```javascript
// 使用 .version-personal 和 .version-corporate class
// JavaScript 動態切換 body class
```

### 2. 資料管理

**資料來源**:
- ✅ 所有內容從 `data.json` 載入
- ❌ 禁止 hardcode 個人資訊在 HTML 中

**自動備份**:
- 每次修改 data.json 後自動備份到 `data/backups/`
- 檔名格式：`data_YYYYMMDD_HHMMSS.json`

### 3. 部署規範

- ✅ 使用 Vercel Git 集成
- ✅ 連結到 ThinkerCafe-tw/thinker_official_website
- ✅ 每次 push 自動觸發 preview 部署
- ✅ 手動 promote 到 production（目前工作流程）
- ❌ 不手動上傳檔案到 Vercel

### 4. Monorepo 部署工作流程

**當前配置**：
- Root Directory: `projects/resume`
- 自動部署: Preview only (`target: null`)
- Production 更新: 手動 promote

**標準操作**：
```bash
# 1. 開發與測試
git add . && git commit -m "更新內容" && git push

# 2. 檢查 preview 部署
vercel ls  # 找到最新的 preview URL

# 3. 推廣到 production
vercel promote <preview-url> --yes
```

---

## 📚 重要文件索引

### 技術文件
- 問題分析報告: `docs/ANALYSIS_REPORT.md`

### 資料檔案
- 備份資料: `data/backups/data_*.json`

---

## 🤖 AI 協作提示

### 常見任務流程

**任務：更新履歷內容**
1. 修改 `data.json` 中的對應欄位
2. 本地測試（vercel dev）
3. 提交並 push 到 Git
4. Git 自動觸發 preview 部署
5. 測試 preview 版本無誤後，手動 promote 到 production

**任務：修改版本切換邏輯**
1. 檢查 JavaScript 的版本切換函式
2. 確認 `.version-personal` 和 `.version-corporate` CSS
3. 測試兩個版本的顯示
4. 檢查是否有內容缺失或重疊

### 要特別注意的地方
- ⚠️ 企業版與個人版的內容切換邏輯需仔細測試
- ⚠️ 響應式設計需在多種螢幕尺寸測試
- ⚠️ data.json 修改後記得備份

---

## 🔗 相關資源

### 專案連結
- **Production**: https://cruz-resume.vercel.app
- **Vercel Dashboard**: https://vercel.com/[team]/cruz-resume

### Monorepo 層級
- 核心憲法: `../../knowledge-base/CLAUDE_ROOT.md`

---

**Generated by**: Claude Code
**Last Updated**: 2025-11-08
**Maintainer**: Cruz Tang
**Status**: Production - Active
