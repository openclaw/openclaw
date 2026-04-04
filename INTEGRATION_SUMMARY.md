# Thinker-News 整合摘要

**狀態**: 分析完成，準備開始整合  
**日期**: 2025-11-08  
**目標位置**: `projects/news/`

---

## 快速決策表

| 項目 | 答案 |
|------|------|
| 應該放在哪裡? | `projects/news/` ✅ |
| 為什麼? | ThinkerCafe 品牌 + thinker.cafe 網域 |
| 技術棧是否改變? | 否 (仍是 Python + GitHub Actions) |
| 需要修改現有配置嗎? | 否 (都是新增) |
| 會影響其他專案嗎? | 可選整合到 projects/website |

---

## 關鍵文件位置

| 內容 | 位置 |
|------|------|
| 完整整合指南 | `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` |
| CLAUDE.md 模板 | 見上方指南的「第 4.3 節」|
| 命名規範 | 見上方指南的「第 5 節」|
| 操作步驟 | 見上方指南的「第 7 節」|

---

## 目錄結構預覽

```
thinker-cafe/
└── projects/
    └── news/                     # 新增
        ├── .github/workflows/
        │   └── daily-news.yml
        ├── scripts/               # Python 腳本
        ├── api/                   # Vercel Serverless
        ├── docs/                  # 文檔
        ├── CLAUDE.md              # AI 記憶 (新建)
        ├── package.json           # 新建
        ├── .gitignore             # 新建
        └── requirements.txt
```

---

## 三大規範

### 1. 命名規範
- Package: `@thinker-cafe/news`
- 目錄: `projects/news` (kebab-case)
- Python: `snake_case`
- CLAUDE.md: 必須包含 `inherits_from` 和 3 層元數據

### 2. 結構規範
- 必須有: CLAUDE.md, package.json, .gitignore, README.md
- 可選有: 測試、文檔、API 路由
- Python 項目需要: requirements.txt

### 3. AI 記憶規範
```yaml
---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: thinker-news
persona: News Automation AI
project_type: internal_automation
---
```

---

## 完成清單 (按順序)

### Phase 1: 準備 (5分鐘)
- [ ] 備份原始 `thinker-news` 目錄
- [ ] 閱讀完整整合指南

### Phase 2: 創建結構 (5分鐘)
- [ ] 創建 `projects/news/` 及子目錄
- [ ] 複製 Python 腳本
- [ ] 複製 GitHub Actions workflow

### Phase 3: 新建檔案 (10分鐘)
- [ ] 創建 CLAUDE.md (使用指南第 4.3 節模板)
- [ ] 創建 package.json
- [ ] 創建 .gitignore
- [ ] 驗證檔案完整性

### Phase 4: 測試 (15分鐘)
- [ ] 本地測試 Python 腳本
- [ ] 驗證目錄結構
- [ ] 檢查路徑引用

### Phase 5: 部署 (10分鐘)
- [ ] Git add & commit
- [ ] Push 到 GitHub
- [ ] GitHub 配置 Secrets
- [ ] 手動觸發 workflow 測試

### Phase 6: 集成 (可選, 20分鐘)
- [ ] 與 projects/website 簡單集成
- [ ] 更新根級 README

---

## 關鍵 Tips

### 技術層面
1. **Python 獨立**: 不通過 pnpm 管理，直接用 pip
2. **GitHub Actions 自動**: 無需修改，會自動運行
3. **生成文件**: 不提交 HTML，只提交源代碼和 .json 配置

### 組織層面
1. **命名一致**: 遵循 `@thinker-cafe/news` 的包名
2. **CLAUDE.md 必須**: 它連接 monorepo 的知識系統
3. **避免重複**: 利用 projects/ 的共享規範

### 維護層面
1. **監控 GitHub Actions**: 日誌在 Actions 頁面
2. **本地測試**: 執行前都先 `python scripts/test_local.py`
3. **備份生成文件**: 定期備份 HTML 和 JSON

---

## 快速命令參考

```bash
# 準備
cp -r ~/Documents/thinker-news ~/Documents/thinker-news.backup
cd ~/Documents/thinker-cafe

# 創建結構
mkdir -p projects/news/{scripts,api,docs,.github/workflows}

# 複製檔案
cp ~/Documents/thinker-news/scripts/*.py projects/news/scripts/
cp ~/Documents/thinker-news/requirements.txt projects/news/
cp ~/Documents/thinker-news/.github/workflows/*.yml projects/news/.github/workflows/

# 驗證
ls -la projects/news/
pnpm list -r | grep news

# 測試
cd projects/news
pip install -r requirements.txt
python scripts/test_local.py

# 部署
git add projects/news/
git commit -m "feat: integrate thinker-news into monorepo as projects/news"
git push origin main
```

---

## 常見問題速答

**Q: 這會破壞現有系統嗎?**  
A: 不會。只是複製和組織，不修改代碼邏輯。

**Q: 需要改 GitHub Actions 的 cron?**  
A: 不需要。workflow 會自動在 projects/news 中運行。

**Q: 環境變數怎麼配置?**  
A: GitHub Secrets 保持不變，projects/news 會自動獲取。

**Q: 可以並行運行新舊系統嗎?**  
A: 可以。在完全切換前運行 1-2 周驗證。

**Q: 生成的 HTML 放哪裡?**  
A: 會放在 `projects/news/YYYY-MM-DD.html` 和 `projects/news/latest.json`

---

## 相關資源

| 資源 | 位置 |
|------|------|
| 完整指南 | `THINKER_NEWS_INTEGRATION_GUIDE.md` |
| Monorepo 結構 | `README.md` |
| 專案狀態 | `PROJECT_STATUS.md` |
| AI 記憶根本 | `knowledge-base/CLAUDE_ROOT.md` |

---

## 預計耗時

- 閱讀本文: 5分鐘
- 閱讀完整指南: 15分鐘
- 實際整合: 45分鐘 - 1小時
- 測試驗證: 20分鐘

**總計**: 1.5 - 2 小時

---

## 下一步

1. **立即**: 閱讀 `THINKER_NEWS_INTEGRATION_GUIDE.md`
2. **今天**: 執行 Phase 1-3 (準備和創建結構)
3. **明天**: 執行 Phase 4-5 (測試和部署)
4. **後天**: 可選 Phase 6 (與 website 集成)

---

**Good luck! 🚀**

Made with by Claude Code  
For Cruz Tang

