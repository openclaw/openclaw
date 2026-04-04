# Monorepo Cleanup Recommendations - 2025/11/08

## 📊 現況總覽

根據掃描結果，thinker-cafe monorepo 目前有**嚴重的重複和冗餘**問題。

### 專案大小統計
```
7.0G    projects/website (主要專案)
951M    projects/website.backup-monorepo-attempt (備份)
305M    projects/website-fresh (未知用途)
2.5M    projects/resume (使用中)
336K    projects/news (使用中)
160K    projects/Icon (macOS 圖示檔，可能是誤加入)
```

**總計**: ~8.2GB

---

## 🚨 嚴重問題

### 問題 1: 根目錄有重複的 app/ 目錄

**位置**: `/Users/thinkercafe/Documents/thinker-cafe/app`

**問題**:
- 根目錄有完整的 `app/`, `components/`, `lib/`, `utils/` 等目錄
- 這些目錄與 `projects/website/` 內容相似但不完全相同
- 造成混淆：哪個才是正確的專案根目錄？

**對比結果**:
```bash
diff -r app/ projects/website/app/
# 主要差異：website/ 內有 Icon 檔案（macOS 特定檔案）
```

**推測原因**:
- 可能是從 monorepo 重構前的殘留
- 或是錯誤的 git 操作導致

**建議**:
- **保留**: `projects/website/` (主要專案)
- **刪除**: 根目錄的 `app/`, `components/`, `lib/`, 等目錄

---

### 問題 2: 三個 website 專案並存

#### 1. `projects/website/` (7.0GB) ✅ 使用中
- **狀態**: 正常運作的主專案
- **問題**: node_modules 過大（需清理）
- **建議**: 保留

#### 2. `projects/website.backup-monorepo-attempt/` (951MB) ❌ 備份
- **狀態**: 從檔名看是 monorepo 嘗試的備份
- **問題**:
  - 951MB 空間浪費
  - 已有 git 版本控制，不需要檔案系統備份
- **建議**: **可以刪除**

#### 3. `projects/website-fresh/` (305MB) ❓ 未知
- **狀態**: 不確定用途
- **大小**: 305MB (包含 node_modules)
- **建議**: **需要確認**
  - 如果是廢棄的重構嘗試 → 刪除
  - 如果是新版本開發中 → 保留但應該 rename

---

### 問題 3: 巨大的 node_modules

```
projects/website/: 7.0GB (可能包含 4-5GB 的 node_modules)
projects/website.backup-monorepo-attempt/: 951MB (大部分是 node_modules)
projects/website-fresh/: 305MB (大部分是 node_modules)
```

**問題**:
- 每個專案都有獨立的 node_modules
- 造成磁碟空間浪費
- git 應該忽略但可能被誤加入

**建議**:
1. 確認 .gitignore 已正確設定（已修復）
2. 刪除所有 node_modules: `find . -name "node_modules" -type d -prune -exec rm -rf '{}' +`
3. 使用 pnpm workspace 共享 dependencies

---

### 問題 4: 重複的檔案和目錄

**根目錄重複**:
- ❌ `/app` → 應該在 `projects/website/app`
- ❌ `/components` → 應該在 `projects/website/components`
- ❌ `/lib` → 應該在 `projects/website/lib`
- ❌ `/utils` → 應該在 `projects/website/utils`
- ❌ `/public` → 應該在 `projects/website/public`
- ❌ `/migrations` → 應該在 `projects/website/migrations`
- ❌ `/hooks` → 應該在 `projects/website/hooks`
- ❌ `/data` → 應該在 `projects/website/data`
- ❌ `/styles` → 應該在 `projects/website/styles`
- ❌ `/__mocks__` → 應該在 `projects/website/__mocks__`

**其他目錄**:
- ✅ `/.kiro` - Curator 人格系統，應保留
- ✅ `/knowledge-base` - 文件庫，應保留
- ✅ `/docs` - 文件，應保留（但檢查是否與 knowledge-base 重複）
- ❓ `/apps` - 空目錄？需確認
- ❓ `/scripts` - 需確認是否與 `.kiro/scripts` 重複

---

## ✅ 清理建議（按優先順序）

### 🔴 緊急（立即執行）

#### 1. 刪除 node_modules
```bash
cd /Users/thinkercafe/Documents/thinker-cafe
find . -name "node_modules" -type d -prune -exec rm -rf '{}' +
```
**預期節省空間**: ~5-6GB

#### 2. 刪除備份目錄
```bash
rm -rf projects/website.backup-monorepo-attempt/
```
**預期節省空間**: ~951MB

#### 3. 清理 macOS Icon 檔案
```bash
find . -name "Icon" -type f -exec rm '{}' +
find . -name "Icon?" -type f -exec rm '{}' +
```
**預期節省空間**: ~幾 KB（但減少檔案數量）

---

### 🟡 重要（需要確認後執行）

#### 4. 確認並處理 projects/website-fresh/

**步驟**:
1. 檢查 `projects/website-fresh/` 的 package.json 和最後修改時間
2. 與 Cruz 確認用途
3. 決定：
   - 如果是廢棄 → 刪除 → **節省 305MB**
   - 如果是新版本 → 保留並 rename 為 `projects/website-v2` 或類似名稱

#### 5. 移除根目錄的重複檔案

**⚠️ 警告**: 這個操作比較危險，建議先備份或確認

**步驟**:
```bash
# 1. 確認沒有獨特內容
diff -r app/ projects/website/app/
diff -r components/ projects/website/components/
# ... 對每個目錄做對比

# 2. 如果確認相同，刪除根目錄版本
rm -rf app/ components/ lib/ utils/ public/ migrations/ hooks/ data/ styles/ __mocks__/
```

**預期節省空間**: ~100-200MB（假設沒有 node_modules）

---

### 🟢 一般（優化）

#### 6. 整理 docs/ 和 knowledge-base/

**檢查**:
- `/docs` 和 `/knowledge-base` 是否有內容重複？
- 是否可以合併？

#### 7. 清理 .turbo/cache

```bash
rm -rf .turbo/cache/*
```
**預期節省空間**: 可能幾十 MB

#### 8. 檢查 apps/ 目錄

```bash
ls -la apps/
```
如果是空的或無用 → 刪除

---

## 📋 執行清單（Checklist）

### Phase 1: 安全清理（不影響功能）

- [ ] 刪除所有 node_modules (5-6GB)
- [ ] 刪除 projects/website.backup-monorepo-attempt/ (951MB)
- [ ] 清理 macOS Icon 檔案
- [ ] 清理 .turbo/cache

**預期總節省**: ~6-7GB

### Phase 2: 確認後清理

- [ ] 確認 projects/website-fresh/ 用途
  - [ ] 如果廢棄 → 刪除 (305MB)
  - [ ] 如果使用中 → rename
- [ ] 確認根目錄檔案與 projects/website/ 是否相同
  - [ ] 對比 diff
  - [ ] 確認沒有獨特內容
  - [ ] 刪除根目錄重複檔案 (100-200MB)

**預期總節省**: ~400-500MB

### Phase 3: 優化

- [ ] 檢查 docs/ 和 knowledge-base/ 是否重複
- [ ] 檢查 apps/ 目錄
- [ ] 檢查 scripts/ 和 .kiro/scripts/ 是否重複

---

## 🎯 清理後的理想結構

```
thinker-cafe/
├── .kiro/                    # Curator 系統
├── .git/                     # Git 版本控制
├── knowledge-base/           # 知識庫
├── docs/                     # 文件（如果不與 knowledge-base 重複）
├── projects/
│   ├── website/             # 主網站專案（清理後 ~2GB）
│   ├── resume/              # 履歷專案（2.5MB）
│   └── news/                # 新聞專案（336KB）
├── node_modules/            # 根 workspace node_modules
├── package.json             # 根 workspace 設定
├── pnpm-workspace.yaml      # pnpm workspace 設定
└── .gitignore               # 已更新

總大小預估: ~2.5GB (從 8.2GB 減少 70%)
```

---

## ⚠️ 注意事項

### 在執行刪除前：

1. **確認 git status**
   ```bash
   git status
   ```
   確保沒有未提交的重要變更

2. **建立臨時備份**（如果不確定）
   ```bash
   tar -czf thinker-cafe-backup-20251108.tar.gz \
     projects/website.backup-monorepo-attempt/ \
     projects/website-fresh/
   ```

3. **檢查磁碟空間**
   ```bash
   df -h
   ```

4. **分階段執行**
   - 不要一次刪除所有
   - 先刪除最明確的（node_modules, backup）
   - 測試專案還能正常運作
   - 再繼續下一階段

---

## 🔍 需要 Cruz 確認的問題

1. **projects/website-fresh/ 的用途是什麼？**
   - 是廢棄的重構嘗試嗎？
   - 還是正在開發的新版本？

2. **根目錄的 app/, components/ 等是否有特殊用途？**
   - 這些是否是 monorepo 重構前的殘留？
   - 還是有其他用途？

3. **docs/ 和 knowledge-base/ 的關係？**
   - 內容是否重複？
   - 是否可以合併？

4. **apps/ 目錄的用途？**
   - 是否是計劃中的 monorepo apps/ 結構？
   - 目前是空的嗎？

---

## 📊 清理效益

### 預期節省空間

| 項目 | 大小 | 優先級 |
|------|------|--------|
| node_modules | 5-6GB | 🔴 高 |
| website.backup-monorepo-attempt | 951MB | 🔴 高 |
| website-fresh (如果廢棄) | 305MB | 🟡 中 |
| 根目錄重複檔案 | 100-200MB | 🟡 中 |
| Icon 檔案 | ~幾 KB | 🟢 低 |
| .turbo/cache | ~幾十 MB | 🟢 低 |
| **總計** | **~6.3-7.5GB** | |

### 清理後預期狀態

- 磁碟空間使用: **2.5GB** (減少 70%)
- 檔案數量: 大幅減少
- Git 倉庫: 更乾淨
- 專案結構: 更清晰

---

**分析完成時間**: 2025/11/08
**分析者**: Claude Code (Sonnet 4.5)
**下一步**: 等待 Cruz 確認後執行清理
