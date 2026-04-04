# Thinker-News 整合到 Monorepo - 完整操作指南

## 🎯 任務目標
將 `thinker-news` 專案整合到 `thinker-cafe` monorepo 的 `projects/news/` 目錄下。

---

## 📚 必讀文件（依序閱讀）

### 1️⃣ 快速摘要（15 分鐘）
**絕對路徑**: `/Users/thinkercafe/Documents/thinker-cafe/INTEGRATION_SUMMARY.md`

**這是什麼**: 執行摘要，包含決策表格和快速檢查清單

**閱讀重點**:
- Section 1: 為什麼選擇 `projects/news/`（不是 `apps/`）
- Section 2: 專案結構與命名規則
- Section 3: 必須遵守的 4 大規則
- Section 4: 整合時間估算（1.5-2 小時）
- **最重要**: 最後的 7 階段檢查清單

**如何使用**:
```bash
# 在編輯器中打開
code /Users/thinkercafe/Documents/thinker-cafe/INTEGRATION_SUMMARY.md

# 或用瀏覽器預覽（如果有 Markdown 預覽工具）
open -a "Typora" /Users/thinkercafe/Documents/thinker-cafe/INTEGRATION_SUMMARY.md
```

---

### 2️⃣ 完整整合手冊（30 分鐘）
**絕對路徑**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md`

**這是什麼**: 12 章節完整整合手冊（1011 行），包含所有模板和步驟

**必讀章節**:
- **Chapter 1**: 整合決策（為什麼是 projects/news/）
- **Chapter 4**: `CLAUDE.md` 模板（直接複製使用）⭐
- **Chapter 5**: `package.json` 模板（直接複製使用）⭐
- **Chapter 6**: 逐步整合指南（12 個步驟）⭐
- **Chapter 8**: 目錄結構範例（tree 輸出）
- **Chapter 9**: 常見問題與解決方案
- **Chapter 10**: 測試與驗證
- **Chapter 12**: 檢查清單

**內建模板**:
- CLAUDE.md 完整範本（第 4 章）
- package.json 完整範本（第 5 章）
- .gitignore 範本（第 6.3 節）

**如何使用**:
```bash
# 打開完整手冊
code /Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md

# 搜尋特定章節（例如 CLAUDE.md 模板）
grep -n "## Chapter 4" /Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md
```

---

### 3️⃣ 架構深度解析（選讀，20 分鐘）
**絕對路徑**: `/Users/thinkercafe/Documents/thinker-cafe/MONOREPO_STRUCTURE_GUIDE.md`

**這是什麼**: Monorepo 架構深度解析，包含命名規則和 AI 記憶系統

**何時閱讀**:
- 想了解「為什麼」某些決策的背後原因
- 需要理解 5 層架構（知識庫 → 專案 → 檔案 → 程式碼）
- 遇到架構相關問題時

**重點章節**:
- Section 2: 5 層 Monorepo 結構
- Section 3: 命名矩陣（projects/ vs apps/）
- Section 4: AI 記憶模型（CLAUDE.md 繼承鏈）

**如何使用**:
```bash
# 打開架構指南
code /Users/thinkercafe/Documents/thinker-cafe/MONOREPO_STRUCTURE_GUIDE.md
```

---

## 🗂️ 專案位置

**來源專案（thinker-news）**:
```
/Users/thinkercafe/Documents/thinker-news/
```

**目標位置（thinker-cafe monorepo）**:
```
/Users/thinkercafe/Documents/thinker-cafe/projects/news/
```

**重要檔案位置**:
```
來源 Python 腳本:    /Users/thinkercafe/Documents/thinker-news/scripts/
來源 API 處理器:     /Users/thinkercafe/Documents/thinker-news/api/
來源文件:           /Users/thinkercafe/Documents/thinker-news/docs/
來源 GitHub Actions: /Users/thinkercafe/Documents/thinker-news/.github/workflows/
來源依賴清單:        /Users/thinkercafe/Documents/thinker-news/requirements.txt
```

---

## ✅ 開始前檢查清單

在開始整合前，請確認：

- [ ] 已閱讀 `INTEGRATION_SUMMARY.md` 的 Section 1-4
- [ ] 已備份 thinker-news 專案
  ```bash
  cp -r /Users/thinkercafe/Documents/thinker-news /Users/thinkercafe/Documents/thinker-news.backup
  ```
- [ ] 已切換到 thinker-cafe 目錄
  ```bash
  cd /Users/thinkercafe/Documents/thinker-cafe
  ```
- [ ] 確認 git 狀態乾淨
  ```bash
  git status
  # 應該顯示: nothing to commit, working tree clean
  ```
- [ ] 確認在正確的分支（通常是 main）
  ```bash
  git branch
  # 應該顯示: * main
  ```

---

## 🚀 整合步驟（7 個階段）

### Phase 1: 建立目錄結構（5 分鐘）

```bash
cd /Users/thinkercafe/Documents/thinker-cafe

# 建立主目錄結構
mkdir -p projects/news/{scripts,api,docs/n8n_workflows,.github/workflows}

# 驗證結構
tree projects/news -L 2
```

**預期輸出**:
```
projects/news/
├── scripts/
├── api/
├── docs/
│   └── n8n_workflows/
└── .github/
    └── workflows/
```

---

### Phase 2: 複製核心檔案（10 分鐘）

```bash
# 複製 Python 腳本
cp -r /Users/thinkercafe/Documents/thinker-news/scripts/* /Users/thinkercafe/Documents/thinker-cafe/projects/news/scripts/

# 複製 API 處理器（Vercel Serverless Functions）
cp -r /Users/thinkercafe/Documents/thinker-news/api/* /Users/thinkercafe/Documents/thinker-cafe/projects/news/api/

# 複製文件
cp -r /Users/thinkercafe/Documents/thinker-news/docs/* /Users/thinkercafe/Documents/thinker-cafe/projects/news/docs/

# 複製 GitHub Actions workflow
cp /Users/thinkercafe/Documents/thinker-news/.github/workflows/daily_news.yml /Users/thinkercafe/Documents/thinker-cafe/projects/news/.github/workflows/

# 複製 Python 依賴清單
cp /Users/thinkercafe/Documents/thinker-news/requirements.txt /Users/thinkercafe/Documents/thinker-cafe/projects/news/

# 複製 Vercel 配置（如果存在）
cp /Users/thinkercafe/Documents/thinker-news/vercel.json /Users/thinkercafe/Documents/thinker-cafe/projects/news/ 2>/dev/null || echo "No vercel.json found (OK)"
```

**驗證**:
```bash
# 檢查檔案是否複製成功
ls -la /Users/thinkercafe/Documents/thinker-cafe/projects/news/scripts/
ls -la /Users/thinkercafe/Documents/thinker-cafe/projects/news/api/
```

---

### Phase 3: 建立新檔案（15 分鐘）

#### 3.1 建立 `CLAUDE.md`

**從哪裡複製**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` 的 **Chapter 4**

```bash
cd /Users/thinkercafe/Documents/thinker-cafe/projects/news

# 創建 CLAUDE.md（從 THINKER_NEWS_INTEGRATION_GUIDE.md Chapter 4 複製內容）
# 手動複製或使用編輯器打開模板
code /Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md
```

**關鍵內容**（必須包含）:
```markdown
# Thinker News - AI 驅動的每日新聞摘要系統

繼承自: `../../knowledge-base/CLAUDE_ROOT.md`

## 專案概述
...
```

#### 3.2 建立 `package.json`

**從哪裡複製**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` 的 **Chapter 5**

```bash
# 創建 package.json（從 Chapter 5 複製內容）
```

**關鍵欄位**（必須正確）:
```json
{
  "name": "@thinker-cafe/news",
  "version": "1.0.0",
  "private": true,
  ...
}
```

#### 3.3 建立 `.gitignore`

**從哪裡複製**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` 的 **Chapter 6.3**

```bash
# 創建 .gitignore
cat > /Users/thinkercafe/Documents/thinker-cafe/projects/news/.gitignore << 'EOF'
# Python
__pycache__/
*.py[cod]
*.egg-info/
venv/
.env

# Generated files
*.html
latest.json

# IDE
.vscode/
.idea/

# OS
.DS_Store
EOF
```

#### 3.4 建立 `README.md`

```bash
cat > /Users/thinkercafe/Documents/thinker-cafe/projects/news/README.md << 'EOF'
# @thinker-cafe/news

AI 驅動的每日新聞摘要系統，自動抓取、摘要、分析台灣新聞並生成精美報告。

## 功能
- 每日自動抓取台灣新聞
- AI 摘要與主題分類
- 多格式輸出（HTML、LINE 訊息）
- LINE Bot 整合

## 技術棧
- Python 3.11+
- OpenAI GPT-4
- Google Gemini
- Vercel Serverless Functions
- LINE Messaging API

## 快速開始

詳見 `CLAUDE.md`
EOF
```

---

### Phase 4: 驗證結構（5 分鐘）

```bash
cd /Users/thinkercafe/Documents/thinker-cafe

# 顯示完整目錄結構
tree projects/news -L 3 -I '__pycache__|*.pyc|venv'
```

**預期輸出**（應該與 `INTEGRATION_SUMMARY.md` Section 3 一致）:
```
projects/news/
├── CLAUDE.md
├── package.json
├── .gitignore
├── README.md
├── requirements.txt
├── vercel.json
├── scripts/
│   ├── main.py
│   ├── fetch_news.py
│   ├── summarize_news.py
│   ├── analyze_news.py
│   └── generate_html.py
├── api/
│   └── line-webhook.py
├── docs/
│   ├── DEPLOYMENT.md
│   ├── TROUBLESHOOTING.md
│   └── n8n_workflows/
│       └── LINE自動發消息.json
└── .github/
    └── workflows/
        └── daily_news.yml
```

**檢查必要檔案**:
```bash
# 確認所有關鍵檔案存在
ls -l projects/news/CLAUDE.md
ls -l projects/news/package.json
ls -l projects/news/requirements.txt
ls -l projects/news/api/line-webhook.py
ls -l projects/news/scripts/main.py
```

---

### Phase 5: 本地測試（15 分鐘）

```bash
cd /Users/thinkercafe/Documents/thinker-cafe/projects/news

# 建立虛擬環境
python3 -m venv venv

# 啟動虛擬環境
source venv/bin/activate

# 安裝依賴
pip install -r requirements.txt

# 測試主程式（需要 API keys）
python3 scripts/main.py
```

**如果沒有 API keys**:
```bash
# 只測試匯入是否成功
python3 -c "import scripts.main; print('✅ Imports OK')"
```

**預期結果**:
- 無 ImportError
- 如果有 API keys，應該生成 HTML 檔案

---

### Phase 6: 提交到 Git（10 分鐘）

```bash
cd /Users/thinkercafe/Documents/thinker-cafe

# 查看變更
git status

# 應該顯示:
# Untracked files:
#   projects/news/

# 加入所有新檔案
git add projects/news

# 再次檢查（確保沒有加入不該加的檔案）
git status

# 確認沒有 .html、latest.json、__pycache__ 等檔案

# 提交
git commit -m "feat: integrate thinker-news into monorepo as projects/news

- Migrate Python scripts, API handlers, and documentation
- Add CLAUDE.md with monorepo context inheritance
- Configure package.json as @thinker-cafe/news
- Include GitHub Actions workflow for daily news generation
- Add Vercel serverless function for LINE Bot webhook"

# 推送到遠端
git push origin main
```

---

### Phase 7: 設定 GitHub Secrets（10 分鐘）

前往 GitHub Repository Settings > Secrets and variables > Actions

**必須設定的 Secrets**:

| Secret 名稱 | 用途 | 如何取得 |
|------------|------|---------|
| `OPENAI_API_KEY` | GPT-4 新聞摘要 | OpenAI Platform |
| `GOOGLE_API_KEY` | Gemini 主題分析 | Google AI Studio |
| `GH_TOKEN` | 推送生成檔案到 GitHub | GitHub Settings > Developer settings > Personal access tokens |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot 發送訊息 | LINE Developers Console |
| `LINE_CHANNEL_SECRET` | LINE Bot 簽名驗證 | LINE Developers Console |

**驗證**:
```bash
# 觸發 GitHub Actions 手動執行
# GitHub > Actions > Daily News Generation > Run workflow
```

---

## ⚠️ 重要規則（開始前必讀）

### 🔴 絕對禁止

1. **不要修改任何現有的 thinker-cafe 檔案**
   - 只能在 `projects/news/` 下新增檔案
   - 不要改動 `apps/`、`packages/`、其他 `projects/`

2. **不要提交生成的檔案**
   - ❌ `*.html`（新聞報告）
   - ❌ `latest.json`（新聞資料）
   - ❌ `__pycache__/`（Python 快取）
   - ✅ 確保 `.gitignore` 包含這些規則

3. **不要在 package.json 中加入 Python 相關腳本**
   - Python 用 `requirements.txt` 管理
   - package.json 只用於 pnpm workspace 識別

### 🟢 必須遵守

1. **Package 名稱**: 必須是 `@thinker-cafe/news`（不是 `@thinker-news` 或其他）

2. **CLAUDE.md 繼承**: 必須包含
   ```markdown
   繼承自: `../../knowledge-base/CLAUDE_ROOT.md`
   ```

3. **目錄結構**: 必須完全符合 `INTEGRATION_SUMMARY.md` Section 3

4. **Git 提交**: 使用語義化提交訊息（feat:, fix:, docs: 等）

---

## 🆘 常見問題

### Q1: 執行 `python3 scripts/main.py` 出現 ImportError

**參考**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` **Chapter 9.1**

**解決方案**:
```bash
# 確認在正確目錄
cd /Users/thinkercafe/Documents/thinker-cafe/projects/news

# 重新建立虛擬環境
rm -rf venv
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

---

### Q2: GitHub Actions 執行失敗

**參考**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` **Chapter 9.2**

**檢查**:
1. 是否所有 Secrets 都已設定
2. `daily_news.yml` 中的路徑是否正確
3. GitHub Actions 是否有寫入權限

**解決方案**:
```bash
# 檢查 workflow 檔案
cat /Users/thinkercafe/Documents/thinker-cafe/projects/news/.github/workflows/daily_news.yml

# 確認路徑是 projects/news/scripts/main.py
```

---

### Q3: Vercel 部署後 LINE Bot 無反應

**參考**: `/Users/thinkercafe/Documents/thinker-news/docs/TROUBLESHOOTING.md`

**檢查**:
1. Vercel 環境變數是否設定（`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`）
2. LINE Developers Console 中 Webhook URL 是否正確
3. **Use webhook** 開關是否開啟

**Webhook URL 應該是**:
```
https://thinker-news.vercel.app/api/line-webhook
```

---

### Q4: 合併衝突

**參考**: `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` **Chapter 9.4**

**避免衝突**:
```bash
# 整合前先拉取最新代碼
cd /Users/thinkercafe/Documents/thinker-cafe
git pull origin main

# 如果有衝突，先解決後再開始整合
```

---

## ✨ 成功驗證清單

完成整合後，請確認：

- [ ] `tree projects/news` 顯示正確結構（與 INTEGRATION_SUMMARY.md Section 3 一致）
- [ ] `cat projects/news/CLAUDE.md` 包含正確的繼承聲明
- [ ] `cat projects/news/package.json` 中 `"name": "@thinker-cafe/news"`
- [ ] `python3 projects/news/scripts/main.py` 可執行（或至少無 ImportError）
- [ ] `git log --oneline -1` 顯示整合提交訊息
- [ ] GitHub Actions 中出現 `daily_news.yml` workflow
- [ ] `git status` 顯示 working tree clean（無未追蹤的生成檔案）
- [ ] `.gitignore` 包含 `*.html` 和 `latest.json`

**最終驗證命令**:
```bash
cd /Users/thinkercafe/Documents/thinker-cafe

# 結構驗證
tree projects/news -L 2 -I 'venv|__pycache__|*.pyc'

# CLAUDE.md 驗證
grep -n "繼承自" projects/news/CLAUDE.md

# package.json 驗證
grep -n '"name":' projects/news/package.json

# Git 驗證
git log --oneline --graph -5

# .gitignore 驗證
grep -E "\.html|latest\.json" projects/news/.gitignore
```

---

## 📞 遇到問題？

### 依嚴重程度查詢

| 問題類型 | 查詢文件 | 絕對路徑 |
|---------|---------|---------|
| 快速問題、決策疑問 | INTEGRATION_SUMMARY.md | `/Users/thinkercafe/Documents/thinker-cafe/INTEGRATION_SUMMARY.md` |
| 詳細步驟、模板 | THINKER_NEWS_INTEGRATION_GUIDE.md | `/Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md` |
| 架構原理、為什麼 | MONOREPO_STRUCTURE_GUIDE.md | `/Users/thinkercafe/Documents/thinker-cafe/MONOREPO_STRUCTURE_GUIDE.md` |
| LINE Bot 問題 | TROUBLESHOOTING.md | `/Users/thinkercafe/Documents/thinker-news/docs/TROUBLESHOOTING.md` |

### 依章節查詢

**THINKER_NEWS_INTEGRATION_GUIDE.md 快速索引**:
- CLAUDE.md 模板 → Chapter 4
- package.json 模板 → Chapter 5
- 逐步整合指南 → Chapter 6
- 目錄結構範例 → Chapter 8
- 常見問題 → Chapter 9
- 測試驗證 → Chapter 10

---

## ⏱️ 時間估算

| 階段 | 時間 | 說明 |
|-----|------|-----|
| 閱讀文件 | 30-45 分鐘 | INTEGRATION_SUMMARY.md + 部分 THINKER_NEWS_INTEGRATION_GUIDE.md |
| Phase 1-2 | 15 分鐘 | 建立結構、複製檔案 |
| Phase 3 | 15 分鐘 | 建立新檔案（CLAUDE.md, package.json 等） |
| Phase 4-5 | 20 分鐘 | 驗證、測試 |
| Phase 6-7 | 20 分鐘 | Git 提交、GitHub Secrets |
| **總計** | **1.5-2 小時** | 包含閱讀、整合、驗證 |

---

## 🎯 最後提醒

1. **不要跳過閱讀**: INTEGRATION_SUMMARY.md 只需 15 分鐘，但能避免 90% 的錯誤
2. **備份很重要**: 萬一出錯，可以從備份重新開始
3. **小步提交**: 完成 Phase 6 後立即推送，不要等待
4. **驗證再驗證**: 每個 Phase 結束後都執行驗證命令
5. **遇到問題先查文件**: 三份指南已涵蓋幾乎所有情況

---

## 🚀 準備好了嗎？

```bash
# 確認所有文件都在正確位置
ls -l /Users/thinkercafe/Documents/thinker-cafe/INTEGRATION_SUMMARY.md
ls -l /Users/thinkercafe/Documents/thinker-cafe/THINKER_NEWS_INTEGRATION_GUIDE.md
ls -l /Users/thinkercafe/Documents/thinker-cafe/MONOREPO_STRUCTURE_GUIDE.md

# 確認來源專案存在
ls -l /Users/thinkercafe/Documents/thinker-news/

# 開始整合！
cd /Users/thinkercafe/Documents/thinker-cafe
```

祝你整合順利！ 🎉

---

**文件版本**: 1.0
**建立日期**: 2025-11-08
**最後更新**: 2025-11-08
**維護者**: ThinkerCafe Development Team
