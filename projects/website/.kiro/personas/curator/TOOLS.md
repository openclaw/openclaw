# Curator Tools 使用指南

## 概述

Curator 是一個 AI Agent，透過 **預先定義好的 Tools** 來執行各種任務。

### 🎯 Tool 設計哲學

```
❌ 錯誤：臨時規劃提示詞
- 每次執行都要想怎麼寫 prompt
- 不一致、不可靠
- 無法複用

✅ 正確：預先設計 Tool
- 提示詞已固定並經過驗證
- 輸入/輸出明確定義
- 可重複執行、可測試
- 沒有未來跟過去，一切都在計劃之中
```

---

## 📋 可用 Tools

### 1. analyze-pricing（定價分析）

**用途**: 分析課程定價，提出調整建議

**使用方式**:
```bash
.kiro/tools/curator/analyze-pricing.sh 5
```

**輸入**:
- `course_id`: 課程 ID（必填）

**輸出**: JSON
```json
{
  "course_id": 5,
  "current_pricing": {...},
  "analysis": {
    "perceived_value": "...",
    "issues": [...]
  },
  "recommendations": [
    {
      "option": "A",
      "strategy": "免費體驗課",
      "pricing": {...}
    }
  ]
}
```

**範例**:
```bash
# 分析課程 5 的定價
./analyze-pricing.sh 5 > pricing-analysis-5.json

# 只看建議
./analyze-pricing.sh 5 | jq '.recommendations'

# 只看 Curator 推薦的方案
./analyze-pricing.sh 5 | jq '.curator_recommendation'
```

---

### 2. analyze-course-images（課程圖片分析）

**用途**: 分析課程所有圖片的視覺內容

**使用方式**:
```bash
.kiro/scripts/curator/curator-analyze-api.sh 5
```

**輸入**:
- `course_id`: 課程 ID（必填）

**輸出**: JSON（圖片分析結果）

---

### 3. check-pricing-consistency（定價一致性檢查）

**狀態**: 🚧 規劃中

**用途**: 檢查 Notion、網站、行銷材料的定價是否一致

---

### 4. suggest-positioning（課程定位建議）

**狀態**: 🚧 規劃中

**用途**: 基於課程內容、圖片、描述，建議課程定位策略

---

### 5. generate-pricing-report（定價報告生成）

**狀態**: 🚧 規劃中

**用途**: 生成完整的定價分析報告

---

## 🔄 Workflows（工作流）

### Workflow 1: 定價稽核

**用途**: 完整的定價稽核流程

**步驟**:
1. 檢查定價一致性
2. 分析每個課程的定價
3. 提出定位建議
4. 生成完整報告

**執行**:
```bash
# 手動執行每個步驟
.kiro/tools/curator/check-pricing-consistency.sh
.kiro/tools/curator/analyze-pricing.sh 5
.kiro/tools/curator/suggest-positioning.sh 5
.kiro/tools/curator/generate-pricing-report.sh

# 或使用 workflow 腳本（未來）
.kiro/tools/curator/workflows/pricing-audit.sh
```

---

### Workflow 2: 課程健康檢查

**用途**: 檢查單一課程的所有面向

**步驟**:
1. 分析視覺內容
2. 分析定價
3. 綜合建議

---

## 🛠️ Tool 結構

每個 Tool 由以下部分組成：

### 1. 提示詞模板
**位置**: `.kiro/tools/curator/prompts/{tool-name}.md`

**內容**:
- Curator 身份定義
- 任務描述
- 執行步驟（固定）
- 輸出格式（固定）
- 權限設定

**特點**:
- ✅ 提示詞固定，不會改變
- ✅ 使用變數替換（{COURSE_ID}）
- ✅ 輸出格式明確

### 2. 執行腳本
**位置**: `.kiro/tools/curator/{tool-name}.sh`

**功能**:
- 讀取輸入參數
- 準備提示詞（變數替換）
- 調用 `claude` CLI
- 驗證輸出
- 返回 JSON

**特點**:
- ✅ stdout = 純 JSON
- ✅ stderr = 執行日誌
- ✅ 可當作 API 使用

### 3. Tool 定義
**位置**: `.kiro/personas/curator/tools.json`

**內容**:
```json
{
  "tools": {
    "analyze-pricing": {
      "id": "analyze-pricing",
      "name": "定價分析",
      "script_path": ".kiro/tools/curator/analyze-pricing.sh",
      "prompt_template": ".kiro/tools/curator/prompts/analyze-pricing.md",
      "inputs": {...},
      "outputs": {...},
      "permissions": {...}
    }
  }
}
```

---

## 🎯 使用場景

### 場景 1: Cruz 想分析定價

```bash
# 方式 1: 直接執行 Tool
.kiro/tools/curator/analyze-pricing.sh 5

# 方式 2: 透過 Curator 執行（未來）
.kiro/scripts/curator/run-tool.sh analyze-pricing --course-id=5
```

### 場景 2: 自動化定期檢查

```bash
# cron job 或 GitHub Actions
0 */6 * * * .kiro/tools/curator/check-pricing-consistency.sh > /tmp/pricing-check.json
```

### 場景 3: 整合到其他系統

```typescript
// 在 TypeScript 中調用
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function analyzePricing(courseId: number) {
  const { stdout } = await execAsync(
    `.kiro/tools/curator/analyze-pricing.sh ${courseId}`
  );

  return JSON.parse(stdout);
}

// 使用
const result = await analyzePricing(5);
console.log(result.curator_recommendation);
```

---

## 📐 Tool 開發流程

### 1. 規劃階段

**問題**: 需要什麼功能？

**例如**:
- 定價太低，需要調整
- 但不知道怎麼定價

**Tool 定義**:
```json
{
  "id": "analyze-pricing",
  "inputs": {"course_id": "number"},
  "outputs": {"recommendations": "array"}
}
```

### 2. 提示詞設計

建立 `.kiro/tools/curator/prompts/analyze-pricing.md`:
- ✅ 定義 Curator 身份
- ✅ 明確任務目標
- ✅ 列出執行步驟（固定）
- ✅ 定義輸出格式（JSON Schema）
- ✅ 設定權限邊界

### 3. 腳本實作

建立 `.kiro/tools/curator/analyze-pricing.sh`:
- ✅ 參數驗證
- ✅ 變數替換
- ✅ 調用 claude CLI
- ✅ 輸出驗證

### 4. 測試

```bash
# 測試執行
./analyze-pricing.sh 5

# 驗證 JSON
./analyze-pricing.sh 5 | jq '.'

# 檢查特定欄位
./analyze-pricing.sh 5 | jq '.recommendations[0].strategy'
```

### 5. 文件化

更新 `tools.json` 和 `TOOLS.md`

---

## 🔒 權限管理

每個 Tool 都明確定義權限：

```json
{
  "permissions": {
    "read": [
      "memory.json",
      "Notion API",
      "/tmp/curator_images/*"
    ],
    "write": [
      ".kiro/personas/curator/reports/"
    ],
    "execute": [
      "pnpm tsx",
      "curl"
    ],
    "forbidden": [
      "修改網站原始碼",
      "執行 git 操作",
      "修改 .env"
    ]
  }
}
```

**在提示詞中明確說明**:
```markdown
## 權限設定

### ✅ 你可以做的事
- 讀取 memory.json
- 分析定價數據

### ❌ 你絕對不能做的事
- 修改任何檔案
- 執行 git 操作
```

---

## 💡 最佳實踐

### 1. Tool 要專注單一任務
```
✅ analyze-pricing: 只分析定價
❌ analyze-everything: 什麼都做
```

### 2. 提示詞要固定且詳細
```
✅ 列出具體步驟 1, 2, 3...
❌ 「請分析定價」（太模糊）
```

### 3. 輸出格式要嚴格定義
```
✅ 提供 JSON Schema
✅ 用 jq 驗證
❌ 隨便輸出
```

### 4. 權限要明確限制
```
✅ 在提示詞中列出可以/不可以做的事
❌ 給完全權限後祈禱不會出事
```

### 5. 文件要完整
```
✅ 每個 Tool 都有使用範例
✅ 說明輸入/輸出
❌ 只有程式碼沒有文件
```

---

## 🚀 未來規劃

### Phase 1: 核心 Tools（當前）
- [x] analyze-pricing
- [x] analyze-course-images
- [ ] check-pricing-consistency
- [ ] suggest-positioning
- [ ] generate-pricing-report

### Phase 2: Workflow 整合
- [ ] pricing-audit workflow
- [ ] course-health-check workflow
- [ ] 自動化執行（cron/GitHub Actions）

### Phase 3: Dashboard
- [ ] 視覺化 Tool 執行結果
- [ ] 追蹤歷史分析
- [ ] 比較不同時間點的建議

---

## 📞 相關文件

- [Curator Persona README](./README.md)
- [Curator API 使用指南](../../scripts/curator/API-USAGE.md)
- [Tools 定義檔](./tools.json)
