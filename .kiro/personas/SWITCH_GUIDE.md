# 人格切換指南

## 🔄 概念

透過切換 `CLAUDE.md` 的內容，讓 Claude Code 進入不同的專注模式，實現心流對話。

## 🎭 可用人格

### Default Mode（預設模式）
- 通用開發助手
- 適合各種開發任務
- 需要每次解釋背景

### Curator Mode（策展人模式）
- 專注於課程內容管理
- 載入完整的 Curator 記憶
- 無需重複解釋背景
- 可直接執行課程相關任務

## 🛠️ 使用方式

### 切換至 Curator 模式

```bash
.kiro/scripts/switch-persona.sh curator
```

**效果**：
- `CLAUDE.md` 被替換為 `.kiro/personas/curator/CLAUDE_CURATOR.md`
- 原始 `CLAUDE.md` 自動備份到 `.kiro/personas/_backups/`
- Claude Code 變成 Curator，載入所有相關記憶

**此時您可以**：
- 直接說「改課程 5 的價格」→ 立即執行
- 問「課程 3 的定價分析」→ 自動使用工具
- 「優化課程 2 的圖片」→ 知道該怎麼做

### 切換回預設模式

```bash
.kiro/scripts/switch-persona.sh default
```

**效果**：
- 從備份恢復原始 `CLAUDE.md`
- Claude Code 回到通用模式

## 💡 使用場景

### 場景 1：專注於課程管理

```bash
# 切換至 Curator 模式
.kiro/scripts/switch-persona.sh curator

# 開啟 Claude Code（會自動讀取 CLAUDE.md）
# 現在可以無縫對話
你：「檢查所有課程的定價一致性」
Curator：「馬上執行 check-pricing-consistency...」

你：「改課程 5 的價格，團班 1200，早鳥 800」
Curator：「開始更新 Notion + 生成圖片 + 驗證...」
```

### 場景 2：回到通用開發

```bash
# 完成課程管理工作後
.kiro/scripts/switch-persona.sh default

# 重新開啟 Claude Code
# 現在回到通用開發模式
```

## 🗂️ 檔案結構

```
.
├── CLAUDE.md                           # 當前啟用的人格定義
├── .kiro/
│   ├── scripts/
│   │   └── switch-persona.sh           # 切換腳本
│   └── personas/
│       ├── SWITCH_GUIDE.md             # 本文件
│       ├── _backups/                   # 備份目錄
│       │   └── CLAUDE.md.backup_*      # 自動備份
│       └── curator/
│           ├── CLAUDE_CURATOR.md       # Curator 人格定義
│           ├── CHANGE_PRICE_SOP.md     # 價格更新 SOP
│           ├── tools.json              # 工具定義
│           └── memory.json             # Curator 記憶
```

## ⚙️ 進階用法

### 新增其他人格

1. 建立人格定義檔：`.kiro/personas/<persona_name>/CLAUDE_<PERSONA_NAME>.md`
2. 在 `switch-persona.sh` 中新增 case
3. 執行切換：`.kiro/scripts/switch-persona.sh <persona_name>`

### 檢查當前模式

```bash
head -5 CLAUDE.md
```

如果看到「你是 Curator」，表示在 Curator 模式。

### 查看備份

```bash
ls -lt .kiro/personas/_backups/
```

## 🎯 優勢

### 傳統方式（不切換）
```
你：「改課程 5 的價格」
Claude：「好的，請問要改成多少？另外，我需要先了解...」
你：「1200，你記得之前的流程嗎？」
Claude：「讓我查一下文件...」
```
→ 需要重複解釋，打斷心流

### 切換後（Curator 模式）
```
你：「改課程 5 的價格，團班 1200，早鳥 800」
Curator：「✅ 更新 Notion
         ✅ 生成定價圖片
         ✅ 上傳完成
         ✅ 驗證網站更新
         完成！」
```
→ 直接執行，心流不斷

## 🚨 注意事項

1. **切換前先完成當前工作**
   - 確保沒有未完成的任務
   - Git commit 所有變更

2. **備份會自動建立**
   - 每次切換都會備份當前 `CLAUDE.md`
   - 時間戳格式：`CLAUDE.md.backup_20251102_120530`

3. **切換後需重新開啟會話**
   - Claude Code 只在啟動時讀取 `CLAUDE.md`
   - 切換後需要開新會話才生效

4. **備份保留策略**
   - 備份會永久保留
   - 可手動清理舊備份：`rm .kiro/personas/_backups/CLAUDE.md.backup_202510*`

## 🎓 最佳實踐

1. **單一焦點工作時使用**
   - 專注於課程管理 → 切換至 Curator
   - 專注於程式開發 → 使用 Default

2. **長時間連續對話時使用**
   - 避免每次都重複背景解釋
   - 提升對話效率

3. **結束後切換回來**
   - 完成特定工作後，切回 Default
   - 保持系統整潔

---

**建立日期**：2025-11-02
**最後更新**：2025-11-02
