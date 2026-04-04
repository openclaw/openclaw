# Curator 2.0 改進方案

**版本**: 2.0.0  
**建立日期**: 2025-11-02  
**負責人**: Cruz Tang  
**目標**: 解決 Curator 的「笨拙」問題，讓它能真正自主、可靠地執行任務

---

## 📊 現況診斷

### 問題 1: 記憶讀取不穩定 ⚠️

**症狀**:
- Curator 嘗試 4 種方法讀取 `memory.json`（jq → Node.js → TypeScript → Python）
- 最終才發現欄位名稱是 `course_id` 而非 `id`
- 浪費大量 token 和時間在試錯

**根本原因**:
```markdown
❌ CLAUDE.md 沒有明確說明 memory.json 的結構
❌ 沒有提供「標準讀取範例」
❌ 沒有處理讀取失敗的降級策略
```

### 問題 2: Index 驗證缺失 ❌

**症狀**:
```json
"highlight_index_mapping": {
  "mapping": {
    "4": { "index": null, "verified": false }  // ← 無法執行
  }
}
```

**根本原因**:
```markdown
❌ 沒有工具可以自動驗證 index
❌ 沒有告訴 Curator 遇到 null 時該怎麼辦
❌ 沒有「初始化」流程來填充這些 index
```

### 問題 3: 工具提示詞不夠精確 📝

**症狀**:
- 工具定義在 `tools.json`，但 Curator 不知道怎麼呼叫
- `CLAUDE.md` 說有 `update-svg-pricing` 工具，但實際上沒有實作
- 模式 C 的「自動執行」變成「手動試錯」

**根本原因**:
```markdown
❌ 工具定義與實際能力脫節
❌ 缺少「工具呼叫範例」
❌ 沒有「自我檢查」機制
```

---

## 🎯 改進目標

### 階段 1: 基礎穩定（Priority: HIGH）
- ✅ 讓 Curator 能穩定讀取 `memory.json`
- ✅ 提供清晰的資料結構文檔
- ✅ 建立標準讀取方法

### 階段 2: 自動驗證（Priority: HIGH）
- ✅ 建立 `verify-index` 工具
- ✅ 自動填充 `highlight_index_mapping`
- ✅ 處理 index 為 null 的情況

### 階段 3: 工具實作（Priority: MEDIUM）
- ✅ 實作所有在 `CLAUDE.md` 中承諾的工具
- ✅ 提供工具呼叫範例
- ✅ 建立工具測試框架

### 階段 4: 自我診斷（Priority: LOW）
- ⭐ 讓 Curator 能自我檢查健康狀態
- ⭐ 自動修復常見問題
- ⭐ 提供詳細的錯誤報告

---

## 🔧 實作方案

## 階段 1: 基礎穩定

### 1.1 更新 CLAUDE.md - 記憶結構說明

**位置**: `.kiro/personas/curator/CLAUDE.md`

**新增章節**:

```markdown
## 📁 記憶檔案結構 (Memory Schema)

### 檔案位置
`.kiro/personas/curator/memory.json`

### 標準讀取方法

**方法 1: Python（推薦）**
```python
import json
with open('.kiro/personas/curator/memory.json', 'r', encoding='utf-8') as f:
    memory = json.load(f)

# 讀取課程資料（注意：欄位名稱是 course_id，不是 id）
courses = memory['courses']
course_4 = next((c for c in courses if c['course_id'] == 4), None)

# 讀取 index 對照表
index_mapping = memory['highlight_index_mapping']['mapping']
course_4_index = index_mapping['4']['index']  # 可能是 null
```

**方法 2: Node.js**
```javascript
const memory = require('./.kiro/personas/curator/memory.json');
const course4 = memory.courses.find(c => c.course_id === 4);
const course4Index = memory.highlight_index_mapping.mapping['4'].index;
```

### 重要欄位說明

#### courses 陣列
```typescript
{
  course_id: number           // ⚠️ 注意：不是 id，是 course_id
  notion_page_id: string      // Notion 頁面 ID
  zh_name: string             // 課程中文名稱
  en_name: string             // 課程英文名稱
  pricing: {
    single_price: number      // 一對一原價
    single_price_early: number // 一對一早鳥價
    group_price: number       // 團班原價
    group_price_early: number // 團班早鳥價
  }
}
```

#### highlight_index_mapping.mapping
```typescript
{
  "[course_id]": {
    index: number | null      // ⚠️ 可能是 null，需要驗證
    verified: boolean         // 是否已驗證
    note: string              // 備註
  }
}
```

### 錯誤處理原則

1. **如果讀取失敗**
   - 回報具體錯誤訊息
   - 不要嘗試多種方法（避免浪費 token）
   - 建議 Cruz 執行 `pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts`

2. **如果欄位不存在**
   - 回報缺少的欄位名稱
   - 不要假設預設值
   - 停止執行，等待指示

3. **如果 index 為 null**
   - 立即停止
   - 回報需要執行 `verify-index`
   - 不要猜測或繼續執行
```

### 1.2 建立 memory-schema.json

**位置**: `.kiro/personas/curator/memory-schema.json`

**用途**: 提供 TypeScript 風格的 Schema，讓 Curator 理解資料結構

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Curator Memory Schema",
  "description": "Curator 人格的記憶檔案結構定義",
  "type": "object",
  "required": ["version", "courses", "highlight_index_mapping"],
  "properties": {
    "version": {
      "type": "string",
      "description": "記憶檔案版本號"
    },
    "courses": {
      "type": "array",
      "description": "所有課程資料",
      "items": {
        "type": "object",
        "required": ["course_id", "notion_page_id", "zh_name", "pricing"],
        "properties": {
          "course_id": {
            "type": "number",
            "description": "課程 ID（注意：不是 id，是 course_id）"
          },
          "notion_page_id": {
            "type": "string",
            "description": "Notion 頁面 ID（UUID 格式）"
          },
          "zh_name": {
            "type": "string",
            "description": "課程中文名稱"
          },
          "en_name": {
            "type": "string",
            "description": "課程英文名稱"
          },
          "pricing": {
            "type": "object",
            "required": [
              "single_price",
              "single_price_early",
              "group_price",
              "group_price_early"
            ],
            "properties": {
              "single_price": {
                "type": "number",
                "description": "一對一原價（TWD）"
              },
              "single_price_early": {
                "type": "number",
                "description": "一對一早鳥價（TWD）"
              },
              "group_price": {
                "type": "number",
                "description": "團班原價（TWD）"
              },
              "group_price_early": {
                "type": "number",
                "description": "團班早鳥價（TWD）"
              }
            }
          }
        }
      }
    },
    "highlight_index_mapping": {
      "type": "object",
      "description": "課程在 HighlightCard 中的 index 對照表",
      "required": ["mapping"],
      "properties": {
        "mapping": {
          "type": "object",
          "description": "以 course_id 為 key 的對照表",
          "patternProperties": {
            "^[0-9]+$": {
              "type": "object",
              "required": ["index", "verified"],
              "properties": {
                "index": {
                  "type": ["number", "null"],
                  "description": "在 HighlightCard 中的 index（0-based），null 表示尚未驗證"
                },
                "verified": {
                  "type": "boolean",
                  "description": "是否已驗證"
                },
                "note": {
                  "type": "string",
                  "description": "備註說明"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

---

## 階段 2: 自動驗證

### 2.1 建立 verify-index.ts 工具

**位置**: `.kiro/scripts/curator/verify-index.ts`

**功能**: 自動驗證並更新 `highlight_index_mapping`

```typescript
/**
 * Curator 工具：自動驗證課程的 Highlight Index
 * 
 * 功能：
 * 1. 呼叫 getProducts() 取得排序後的課程陣列
 * 2. 找出每個課程在陣列中的 index
 * 3. 更新 memory.json 中的 highlight_index_mapping
 * 4. 標記為 verified: true
 * 
 * 使用方式：
 * pnpm tsx .kiro/scripts/curator/verify-index.ts [course_id]
 * 
 * 範例：
 * pnpm tsx .kiro/scripts/curator/verify-index.ts 4
 * pnpm tsx .kiro/scripts/curator/verify-index.ts --all
 */

import { getProducts } from '@/lib/notion'
import fs from 'fs'
import path from 'path'

interface MemorySchema {
  highlight_index_mapping: {
    mapping: {
      [courseId: string]: {
        index: number | null
        verified: boolean
        note: string
      }
    }
  }
}

async function verifyIndex(courseId?: number) {
  console.log('🔍 開始驗證 Highlight Index...\n')

  // 1. 讀取 memory.json
  const memoryPath = path.join(
    process.cwd(),
    '.kiro/personas/curator/memory.json'
  )
  const memory: MemorySchema = JSON.parse(
    fs.readFileSync(memoryPath, 'utf-8')
  )

  // 2. 呼叫 getProducts() 取得排序後的陣列
  console.log('📚 從 Notion 讀取課程列表...')
  const products = await getProducts()
  console.log(`✅ 成功讀取 ${products.length} 個課程\n`)

  // 3. 建立 course_id → index 的對照表
  const indexMap = new Map<number, number>()
  products.forEach((product, index) => {
    indexMap.set(product.id, index)
  })

  // 4. 更新 memory.json
  let updatedCount = 0
  const targetCourseIds = courseId
    ? [courseId]
    : Object.keys(memory.highlight_index_mapping.mapping).map(Number)

  for (const cid of targetCourseIds) {
    const idx = indexMap.get(cid)
    
    if (idx === undefined) {
      console.log(`⚠️  課程 ${cid}: 未發布或不存在`)
      continue
    }

    const currentData = memory.highlight_index_mapping.mapping[String(cid)]
    
    if (currentData.index !== idx || !currentData.verified) {
      memory.highlight_index_mapping.mapping[String(cid)] = {
        index: idx,
        verified: true,
        note: `Auto-verified at ${new Date().toISOString().split('T')[0]}`
      }
      updatedCount++
      console.log(`✅ 課程 ${cid}: index 設定為 ${idx}`)
    } else {
      console.log(`✓  課程 ${cid}: index ${idx} 已驗證，無需更新`)
    }
  }

  // 5. 寫回檔案
  if (updatedCount > 0) {
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2), 'utf-8')
    console.log(`\n💾 已更新 ${updatedCount} 個課程的 index`)
  } else {
    console.log('\n✓  所有課程 index 都已是最新狀態')
  }

  // 6. 顯示完整對照表
  console.log('\n📊 當前 Index 對照表:')
  console.log('─'.repeat(50))
  for (const [cid, data] of Object.entries(
    memory.highlight_index_mapping.mapping
  )) {
    const status = data.verified ? '✅' : '❌'
    const idx = data.index ?? 'null'
    console.log(`${status} 課程 ${cid}: index ${idx}`)
  }
  console.log('─'.repeat(50))
}

// 命令列參數處理
const args = process.argv.slice(2)
if (args.length === 0) {
  console.log('使用方式：')
  console.log('  pnpm tsx .kiro/scripts/curator/verify-index.ts 4')
  console.log('  pnpm tsx .kiro/scripts/curator/verify-index.ts --all')
  process.exit(1)
}

const courseId = args[0] === '--all' ? undefined : Number(args[0])
verifyIndex(courseId).catch(console.error)
```

### 2.2 更新 CLAUDE.md - 處理 Index 為 Null

**在「模式 C: SVG 定價圖快速更新」章節加入**:

```markdown
### 前置檢查（Preflight Check）

執行流程前，必須先檢查：

```python
import json
with open('.kiro/personas/curator/memory.json', 'r') as f:
    memory = json.load(f)

target_index = memory['highlight_index_mapping']['mapping']['4']['index']

if target_index is None:
    # 停止執行，回報錯誤
    print("""
    ❌ 無法執行：課程 4 的 index 尚未驗證
    
    請執行以下指令來驗證 index：
    pnpm tsx .kiro/scripts/curator/verify-index.ts 4
    
    或者手動驗證：
    1. 訪問 http://localhost:3000/products/4
    2. 檢查「課程亮點」區塊中此課程的位置
    3. 手動更新 memory.json 中的 index 值
    """)
    exit(1)
```

**停止條件（更新）**：
- 找不到目標課程資料
- 找不到參考 SVG 模板
- ❌ **target_index 為 null（必須先執行 verify-index）** ← NEW
- 計算出的節省金額為負數

**自動修復選項（可選）**：
如果你希望 Curator 自動執行 verify-index：

```markdown
if target_index is None:
    print("⚠️  Index 尚未驗證，自動執行 verify-index...")
    import subprocess
    result = subprocess.run([
        'pnpm', 'tsx', 
        '.kiro/scripts/curator/verify-index.ts', 
        str(target_course_id)
    ], capture_output=True, text=True)
    
    if result.returncode == 0:
        # 重新載入 memory.json
        with open('.kiro/personas/curator/memory.json', 'r') as f:
            memory = json.load(f)
        target_index = memory['highlight_index_mapping']['mapping'][str(target_course_id)]['index']
        print(f"✅ Index 已驗證：{target_index}")
    else:
        print("❌ 自動驗證失敗，請手動處理")
        exit(1)
```
```

---

## 階段 3: 工具實作

### 3.1 實作 update-svg-pricing 工具

**位置**: `.kiro/scripts/curator/update-svg-pricing.ts`

**功能**: 一鍵更新 HighlightCard.js 中的 SVG 定價圖

```typescript
/**
 * Curator 工具：更新 SVG 定價圖
 * 
 * 功能：
 * 1. 從 memory.json 讀取目標課程價格
 * 2. 從 HighlightCard.js 複製參考 SVG 模板
 * 3. 替換價格數字
 * 4. 更新 HighlightCard.js
 * 
 * 使用方式：
 * pnpm tsx .kiro/scripts/curator/update-svg-pricing.ts \
 *   --target 4 \
 *   --reference 5
 */

import fs from 'fs'
import path from 'path'

interface UpdateOptions {
  targetCourseId: number
  referenceCourseId: number
  autoVerifyIndex?: boolean
}

async function updateSVGPricing(options: UpdateOptions) {
  console.log('🎨 開始更新 SVG 定價圖...\n')

  // 1. 讀取 memory.json
  const memoryPath = path.join(
    process.cwd(),
    '.kiro/personas/curator/memory.json'
  )
  const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'))

  // 2. 檢查 target index
  const targetMapping =
    memory.highlight_index_mapping.mapping[String(options.targetCourseId)]

  if (!targetMapping || targetMapping.index === null) {
    if (options.autoVerifyIndex) {
      console.log('⚠️  Target index 尚未驗證，自動執行 verify-index...')
      // 這裡可以呼叫 verify-index.ts
      // 或者提示使用者手動執行
    }

    console.error(`❌ 課程 ${options.targetCourseId} 的 index 尚未驗證`)
    console.error('請先執行：')
    console.error(
      `pnpm tsx .kiro/scripts/curator/verify-index.ts ${options.targetCourseId}`
    )
    process.exit(1)
  }

  const targetIndex = targetMapping.index
  const referenceMapping =
    memory.highlight_index_mapping.mapping[String(options.referenceCourseId)]

  if (!referenceMapping || referenceMapping.index === null) {
    console.error(`❌ 參考課程 ${options.referenceCourseId} 的 index 尚未驗證`)
    process.exit(1)
  }

  const referenceIndex = referenceMapping.index

  console.log(`📋 Target: 課程 ${options.targetCourseId}, index ${targetIndex}`)
  console.log(
    `📋 Reference: 課程 ${options.referenceCourseId}, index ${referenceIndex}\n`
  )

  // 3. 讀取目標課程價格
  const targetCourse = memory.courses.find(
    (c: any) => c.course_id === options.targetCourseId
  )

  if (!targetCourse) {
    console.error(`❌ 找不到課程 ${options.targetCourseId}`)
    process.exit(1)
  }

  const pricing = {
    groupEarly: targetCourse.pricing.group_price_early,
    singleEarly: targetCourse.pricing.single_price_early,
    groupOriginal: targetCourse.pricing.group_price,
    singleOriginal: targetCourse.pricing.single_price
  }

  const savings = {
    group: pricing.groupOriginal - pricing.groupEarly,
    single: pricing.singleOriginal - pricing.singleEarly
  }

  console.log('💰 定價資料:')
  console.log(`   團班早鳥: ${pricing.groupEarly}（省 ${savings.group}）`)
  console.log(`   一對一早鳥: ${pricing.singleEarly}（省 ${savings.single}）\n`)

  // 4. 讀取 HighlightCard.js
  const highlightCardPath = path.join(
    process.cwd(),
    'app/products/[id]/HighlightCard.js'
  )
  let highlightCardContent = fs.readFileSync(highlightCardPath, 'utf-8')

  // 5. 提取參考 SVG（假設格式為：index === referenceIndex）
  const referenceRegex = new RegExp(
    `index === ${referenceIndex}[^}]*?testSVG\\s*=\\s*\`([^\`]+)\``,
    's'
  )
  const referenceMatch = highlightCardContent.match(referenceRegex)

  if (!referenceMatch) {
    console.error(`❌ 找不到參考課程的 SVG（index ${referenceIndex}）`)
    process.exit(1)
  }

  let newSVG = referenceMatch[1]

  // 6. 替換價格數字（這裡需要根據實際 SVG 結構調整）
  // 假設 SVG 中的價格格式為：$1,480 這樣
  // 你需要根據實際的 SVG 模板來寫替換邏輯

  console.log('✅ SVG 模板已提取')
  console.log('⚠️  注意：價格替換邏輯需要根據實際 SVG 結構實作\n')

  // 7. 更新或新增 targetIndex 的 SVG
  const targetCondition = `index === ${targetIndex}`
  const targetRegex = new RegExp(
    `${targetCondition}[^}]*?testSVG\\s*=\\s*\`[^\`]+\``,
    's'
  )

  if (highlightCardContent.includes(targetCondition)) {
    // 已存在，替換
    highlightCardContent = highlightCardContent.replace(
      targetRegex,
      `${targetCondition} {\n      testSVG = \`${newSVG}\``
    )
    console.log(`✅ 已更新 index ${targetIndex} 的 SVG`)
  } else {
    // 不存在，新增
    // 這裡需要找到合適的插入位置
    console.log(`⚠️  index ${targetIndex} 不存在，需要手動新增`)
  }

  // 8. 寫回檔案
  fs.writeFileSync(highlightCardPath, highlightCardContent, 'utf-8')

  console.log('\n✅ 更新完成！')
  console.log('\n下一步：')
  console.log('1. 執行 pnpm dev 啟動本地測試')
  console.log(`2. 訪問 http://localhost:3000/products/${options.targetCourseId}`)
  console.log('3. 確認定價圖顯示正確')
  console.log('4. 確認無誤後，告知是否上線')
}

// 命令列參數處理
const args = process.argv.slice(2)
const options: Partial<UpdateOptions> = {}

for (let i = 0; i < args.length; i += 2) {
  const key = args[i]
  const value = args[i + 1]

  switch (key) {
    case '--target':
      options.targetCourseId = Number(value)
      break
    case '--reference':
      options.referenceCourseId = Number(value)
      break
    case '--auto-verify':
      options.autoVerifyIndex = true
      i-- // 這個參數沒有值
      break
  }
}

if (!options.targetCourseId || !options.referenceCourseId) {
  console.log('使用方式：')
  console.log(
    '  pnpm tsx .kiro/scripts/curator/update-svg-pricing.ts --target 4 --reference 5'
  )
  console.log('\n選項：')
  console.log('  --target       目標課程 ID')
  console.log('  --reference    參考課程 ID（複製其 SVG 模板）')
  console.log('  --auto-verify  自動驗證 index（如果為 null）')
  process.exit(1)
}

updateSVGPricing(options as UpdateOptions).catch(console.error)
```

### 3.2 更新 tools.json

**位置**: `.kiro/personas/curator/tools.json`

**新增工具定義**:

```json
{
  "tools": [
    {
      "name": "verify-index",
      "description": "驗證課程在 HighlightCard 中的 index",
      "command": "pnpm tsx .kiro/scripts/curator/verify-index.ts",
      "parameters": [
        {
          "name": "course_id",
          "type": "number",
          "required": false,
          "description": "要驗證的課程 ID，若省略則驗證所有課程"
        }
      ],
      "examples": [
        "verify-index 4",
        "verify-index --all"
      ],
      "when_to_use": [
        "當 memory.json 中的 index 為 null 時",
        "當新增課程後需要初始化 index 時",
        "當懷疑 index 對照表不準確時"
      ],
      "output": {
        "success": "✅ 課程 X: index 設定為 Y",
        "failure": "❌ 課程 X: 未發布或不存在"
      }
    },
    {
      "name": "update-svg-pricing",
      "description": "更新課程的 SVG 定價圖",
      "command": "pnpm tsx .kiro/scripts/curator/update-svg-pricing.ts",
      "parameters": [
        {
          "name": "target",
          "type": "number",
          "required": true,
          "description": "目標課程 ID"
        },
        {
          "name": "reference",
          "type": "number",
          "required": true,
          "description": "參考課程 ID（複製其 SVG 模板）"
        },
        {
          "name": "auto-verify",
          "type": "boolean",
          "required": false,
          "description": "如果 index 為 null，自動執行 verify-index"
        }
      ],
      "examples": [
        "update-svg-pricing --target 4 --reference 5",
        "update-svg-pricing --target 4 --reference 5 --auto-verify"
      ],
      "when_to_use": [
        "當收到「把第X課的highlight1價格參照第Y課改成svg」指令時",
        "當需要快速複製並修改定價圖時"
      ],
      "preconditions": [
        "target 和 reference 的 index 都必須已驗證（非 null）",
        "或者使用 --auto-verify 參數"
      ],
      "output": {
        "success": "✅ 更新完成！請訪問 http://localhost:3000/products/X 確認",
        "failure": "❌ 課程 X 的 index 尚未驗證，請先執行 verify-index"
      }
    }
  ]
}
```

---

## 階段 4: 自我診斷

### 4.1 建立 diagnose-memory.ts

**位置**: `.kiro/scripts/curator/diagnose-memory.ts`

**功能**: 檢查 memory.json 的完整性，產生健康報告

```typescript
/**
 * Curator 工具：記憶健康診斷
 * 
 * 功能：
 * 1. 檢查 memory.json 是否存在且可讀取
 * 2. 驗證所有必要欄位是否存在
 * 3. 檢查所有 index 是否已驗證
 * 4. 檢查定價資料是否合理
 * 5. 產生健康報告
 * 
 * 使用方式：
 * pnpm tsx .kiro/scripts/curator/diagnose-memory.ts
 */

import fs from 'fs'
import path from 'path'

interface DiagnosticResult {
  status: 'healthy' | 'warning' | 'error'
  category: string
  message: string
  suggestion?: string
}

async function diagnoseMemory(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = []
  const memoryPath = path.join(
    process.cwd(),
    '.kiro/personas/curator/memory.json'
  )

  // 1. 檢查檔案是否存在
  if (!fs.existsSync(memoryPath)) {
    results.push({
      status: 'error',
      category: 'File Access',
      message: 'memory.json 不存在',
      suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
    })
    return results
  }

  results.push({
    status: 'healthy',
    category: 'File Access',
    message: '✅ memory.json 存在且可讀取'
  })

  // 2. 讀取並解析 JSON
  let memory: any
  try {
    memory = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'))
    results.push({
      status: 'healthy',
      category: 'JSON Parsing',
      message: '✅ JSON 格式正確'
    })
  } catch (error) {
    results.push({
      status: 'error',
      category: 'JSON Parsing',
      message: `❌ JSON 解析失敗: ${error}`,
      suggestion: '請檢查 JSON 語法是否正確'
    })
    return results
  }

  // 3. 檢查必要欄位
  const requiredFields = [
    'version',
    'courses',
    'highlight_index_mapping'
  ]

  for (const field of requiredFields) {
    if (!(field in memory)) {
      results.push({
        status: 'error',
        category: 'Schema',
        message: `❌ 缺少必要欄位: ${field}`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
      })
    }
  }

  // 4. 檢查 courses 陣列
  if (Array.isArray(memory.courses)) {
    results.push({
      status: 'healthy',
      category: 'Courses',
      message: `✅ 共有 ${memory.courses.length} 個課程`
    })

    // 檢查每個課程的必要欄位
    const requiredCourseFields = [
      'course_id',
      'notion_page_id',
      'zh_name',
      'pricing'
    ]

    let missingFieldCount = 0
    memory.courses.forEach((course: any, index: number) => {
      for (const field of requiredCourseFields) {
        if (!(field in course)) {
          missingFieldCount++
        }
      }
    })

    if (missingFieldCount > 0) {
      results.push({
        status: 'warning',
        category: 'Courses',
        message: `⚠️  有 ${missingFieldCount} 個課程缺少必要欄位`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
      })
    } else {
      results.push({
        status: 'healthy',
        category: 'Courses',
        message: '✅ 所有課程都有完整的必要欄位'
      })
    }
  }

  // 5. 檢查 highlight_index_mapping
  if (memory.highlight_index_mapping?.mapping) {
    const mapping = memory.highlight_index_mapping.mapping
    const totalCourses = Object.keys(mapping).length
    const nullIndexCount = Object.values(mapping).filter(
      (m: any) => m.index === null
    ).length
    const unverifiedCount = Object.values(mapping).filter(
      (m: any) => !m.verified
    ).length

    if (nullIndexCount > 0) {
      results.push({
        status: 'warning',
        category: 'Index Mapping',
        message: `⚠️  有 ${nullIndexCount} 個課程的 index 為 null`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/verify-index.ts --all'
      })
    }

    if (unverifiedCount > 0) {
      results.push({
        status: 'warning',
        category: 'Index Mapping',
        message: `⚠️  有 ${unverifiedCount} 個課程的 index 未驗證`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/verify-index.ts --all'
      })
    }

    if (nullIndexCount === 0 && unverifiedCount === 0) {
      results.push({
        status: 'healthy',
        category: 'Index Mapping',
        message: `✅ 所有 ${totalCourses} 個課程的 index 都已驗證`
      })
    }
  }

  // 6. 檢查定價合理性
  if (Array.isArray(memory.courses)) {
    let pricingIssues = 0

    memory.courses.forEach((course: any) => {
      if (course.pricing) {
        const { single_price, single_price_early, group_price, group_price_early } =
          course.pricing

        // 檢查早鳥價是否低於原價
        if (single_price_early >= single_price) {
          pricingIssues++
        }
        if (group_price_early >= group_price) {
          pricingIssues++
        }

        // 檢查一對一價格是否高於團班
        if (single_price < group_price) {
          pricingIssues++
        }
      }
    })

    if (pricingIssues > 0) {
      results.push({
        status: 'warning',
        category: 'Pricing',
        message: `⚠️  有 ${pricingIssues} 個定價異常`,
        suggestion: '請檢查課程定價是否合理'
      })
    } else {
      results.push({
        status: 'healthy',
        category: 'Pricing',
        message: '✅ 所有定價都在合理範圍內'
      })
    }
  }

  return results
}

// 執行診斷並顯示報告
diagnoseMemory().then(results => {
  console.log('🏥 Curator 記憶健康診斷報告')
  console.log('='.repeat(60))
  console.log()

  const categories = [...new Set(results.map(r => r.category))]

  for (const category of categories) {
    console.log(`\n📋 ${category}`)
    console.log('-'.repeat(60))

    const categoryResults = results.filter(r => r.category === category)

    for (const result of categoryResults) {
      console.log(`   ${result.message}`)
      if (result.suggestion) {
        console.log(`   💡 建議: ${result.suggestion}`)
      }
    }
  }

  console.log()
  console.log('='.repeat(60))

  const errorCount = results.filter(r => r.status === 'error').length
  const warningCount = results.filter(r => r.status === 'warning').length

  if (errorCount > 0) {
    console.log(`\n❌ 發現 ${errorCount} 個錯誤，${warningCount} 個警告`)
    console.log('建議：請先修復錯誤，再處理警告')
    process.exit(1)
  } else if (warningCount > 0) {
    console.log(`\n⚠️  發現 ${warningCount} 個警告`)
    console.log('建議：建議修復這些警告以確保系統穩定')
  } else {
    console.log('\n✅ 所有檢查都通過！記憶系統健康')
  }
})
```

### 4.2 更新 CLAUDE.md - 啟動時自動診斷

**在「Curator 人格已啟動」章節加入**:

```markdown
## 🚀 啟動檢查清單

每次 Curator 啟動時，應執行以下檢查：

### 1. 記憶健康診斷

```bash
pnpm tsx .kiro/scripts/curator/diagnose-memory.ts
```

如果發現問題：
- ❌ 錯誤（Error）: 立即停止，回報給 Cruz
- ⚠️ 警告（Warning）: 記錄下來，可以繼續工作但需告知

### 2. 確認工具可用性

檢查以下工具是否存在：
- [ ] `.kiro/scripts/curator/verify-index.ts`
- [ ] `.kiro/scripts/curator/update-svg-pricing.ts`
- [ ] `.kiro/scripts/curator/build-memory-v1.5.ts`
- [ ] `.kiro/scripts/curator/upload-to-notion.ts`

### 3. 確認記憶檔案最新

檢查 `memory.json` 的 `last_updated` 時間：
- 如果超過 30 分鐘，建議刷新
- 如果超過 24 小時，強制刷新

### 啟動訊息範例

```
🎯 Curator 2.0 已啟動

✅ 記憶健康診斷: 通過
✅ 工具可用性: 4/4 工具正常
✅ 記憶更新時間: 15 分鐘前

⚠️  警告: 有 2 個課程的 index 尚未驗證
    → 建議執行: pnpm tsx .kiro/scripts/curator/verify-index.ts --all

準備就緒！可以開始工作。
```
```

---

## 📊 實作優先級與時程

### 立即實作（今天完成）

✅ **Priority 1: 更新 CLAUDE.md**
- 新增記憶結構說明
- 新增錯誤處理原則
- 新增前置檢查流程
- 時間: 30 分鐘

✅ **Priority 2: 建立 verify-index.ts**
- 實作自動驗證功能
- 時間: 1 小時

✅ **Priority 3: 手動驗證課程 4**
- 執行 `pnpm tsx .kiro/scripts/curator/verify-index.ts 4`
- 更新 memory.json
- 時間: 5 分鐘

### 本週完成

⭐ **Priority 4: 實作 update-svg-pricing.ts**
- 完整的 SVG 更新流程
- 時間: 2 小時

⭐ **Priority 5: 建立 diagnose-memory.ts**
- 自動健康檢查
- 時間: 1.5 小時

⭐ **Priority 6: 更新 tools.json**
- 新增工具定義
- 提供使用範例
- 時間: 30 分鐘

### 後續優化

🔮 **Priority 7: 自動修復機制**
- 讓 Curator 能自動修復常見問題
- 時間: 3 小時

🔮 **Priority 8: 完整測試框架**
- 單元測試
- 整合測試
- 時間: 4 小時

---

## 🎯 成功指標

### 階段 1 完成標準
- [ ] Curator 能用一個方法穩定讀取 memory.json
- [ ] 不再出現「試了 4 種方法才成功」的情況
- [ ] 所有欄位名稱正確（course_id, not id）

### 階段 2 完成標準
- [ ] 所有發布課程的 index 都已驗證（非 null）
- [ ] 執行模式 C 時不會因為 index 為 null 而失敗
- [ ] verify-index 工具可以正常運作

### 階段 3 完成標準
- [ ] update-svg-pricing 工具可以正常運作
- [ ] 能在 5 分鐘內完成一個課程的 SVG 更新
- [ ] tools.json 與實際工具完全對應

### 階段 4 完成標準
- [ ] diagnose-memory 能正確識別所有問題
- [ ] Curator 啟動時自動執行健康檢查
- [ ] 錯誤訊息清晰、可操作

---

## 🔄 迭代計畫

### Version 2.1 (下週)
- 支援批次更新多個課程
- 自動生成定價報告
- 整合到 CI/CD 流程

### Version 2.2 (下個月)
- 視覺化記憶狀態儀表板
- 自動價格建議系統
- A/B Testing 支援

### Version 3.0 (未來)
- 完全自主的價格優化
- 與 Notion 雙向同步
- 多語言支援

---

## 📝 附錄

### A. 快速參考

**記憶檔案位置**
```
.kiro/personas/curator/memory.json
```

**常用工具**
```bash
# 刷新記憶
pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts

# 驗證 index
pnpm tsx .kiro/scripts/curator/verify-index.ts 4
pnpm tsx .kiro/scripts/curator/verify-index.ts --all

# 更新 SVG
pnpm tsx .kiro/scripts/curator/update-svg-pricing.ts --target 4 --reference 5

# 健康診斷
pnpm tsx .kiro/scripts/curator/diagnose-memory.ts
```

### B. 故障排除

**Q: memory.json 讀取失敗**
```bash
# 重新生成
pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts

# 檢查權限
ls -la .kiro/personas/curator/memory.json
```

**Q: index 一直是 null**
```bash
# 手動驗證
pnpm tsx .kiro/scripts/curator/verify-index.ts --all

# 檢查課程是否已發布
# 訪問 Notion 資料庫確認 published = true
```

**Q: SVG 更新後顯示錯誤**
```bash
# 檢查本地網站
pnpm dev

# 訪問課程頁面
open http://localhost:3000/products/4

# 檢查瀏覽器 Console 是否有錯誤
```

### C. 聯絡人

- **技術負責人**: Cruz Tang
- **文件維護**: Curator 2.0
- **最後更新**: 2025-11-02

---

**End of Document**
