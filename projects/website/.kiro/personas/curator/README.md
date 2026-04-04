# Curator Persona - Phase 1.5

商品策展人 (Curator) 記憶系統 v1.5

## 概述

Curator 是一個負責管理網站課程資料的 AI 人格。此人格從 Notion 讀取課程資料，並維護一個包含時間戳記和能力驗證的記憶系統。

## Phase 1.5 功能

### ✅ 已實作

1. **FR-3: 時效性管理 (Timeliness Management)**
   - 為所有資料添加 `fetched_at` 時間戳記
   - 實作 TTL (Time To Live) 系統
   - 提供 `isStale()` 檢查機制
   - 記憶年齡追蹤

2. **FR-4: 能力驗證系統 (Capability Grading)**
   - 6 種能力狀態追蹤：
     - ✅ `read_notion_data`: verified (100% confidence)
     - ✅ `extract_pricing`: verified (100% confidence)
     - ✅ `collect_images`: verified (100% confidence)
     - ⏳ `analyze_images`: theoretical (0% confidence) - 等待 FR-1
     - ⏳ `modify_notion_data`: theoretical (0% confidence) - 等待 FR-2
     - ⏳ `verify_website_update`: theoretical (50% confidence) - 等待 FR-2

3. **增強型記憶結構**
   - 版本號追蹤 (`version: "1.5.0"`)
   - 元資料區塊 (`metadata`)
   - TTL 設定 (課程/定價/圖片/視覺分析)
   - 能力驗證區塊 (`capabilities`)

### 🚧 待實作

1. **FR-1: 視覺記憶 (Visual Memory)** - ⚠️ 技術限制
   - **狀態**: `unverified`
   - **限制**: Notion 圖片為 S3 signed URL，Read tool 無法讀取外部 URL
   - **替代方案**:
     - 使用 Notion API 下載檔案後再分析
     - 或記錄 URL 但不進行視覺分析
   - **決定**: 暫不實作，僅記錄圖片 URL

2. **FR-2: Notion 修改驗證 (Notion Modification Test)** - Phase 1.5.2
   - 測試修改 Notion 定價
   - 驗證網站 60 秒 revalidate 機制
   - 記錄測試結果

## 檔案結構

```
.kiro/
├── personas/
│   └── curator/
│       ├── README.md                    # 本檔案
│       └── memory.json                  # 記憶檔案 (498KB)
├── scripts/
│   └── curator/
│       ├── build-memory.ts              # 原始記憶建構腳本 (Phase 1.0)
│       ├── build-memory-v1.5.ts         # 增強版記憶建構腳本 (Phase 1.5)
│       ├── run.sh                       # Phase 1.0 執行腳本
│       ├── run-v1.5.sh                  # Phase 1.5 執行腳本
│       ├── check-memory-freshness.ts    # 時效性檢查工具
│       └── analyze-images.ts            # 視覺分析工具 (部分實作)
└── specs/
    └── curator-personas-memory-system-reads-course-data-f/
        └── requirements.md              # Phase 1.5 需求文件
```

## 使用方式

### 1. 建立/更新記憶

```bash
# Phase 1.5 版本 (推薦)
.kiro/scripts/curator/run-v1.5.sh

# 或使用 Phase 1.0 版本
.kiro/scripts/curator/run.sh
```

### 2. 檢查記憶時效性

```bash
pnpm tsx .kiro/scripts/curator/check-memory-freshness.ts
```

輸出範例：
```
🕐 檢查 Curator 記憶時效性...

📊 整體記憶狀態:
   版本: 1.5.0
   建立時間: 2025-11-02T07:09:06.874Z
   最後更新: 2025-11-02T07:09:06.874Z
   記憶年齡: 51 秒

⏱️  TTL 設定:
   課程資料: 3600 秒 (60 分鐘)
   定價資料: 1800 秒 (30 分鐘)
   圖片資料: 86400 秒 (24 小時)
   視覺分析: 604800 秒 (7 天)

📋 摘要:
   總課程數: 21
   過期課程資料: 0
   過期定價資料: 0
   過期圖片資料: 0

   ✅ 所有資料都是最新的！
```

### 3. 讀取記憶

```typescript
import memory from '.kiro/personas/curator/memory.json';

// 檢查版本
console.log(memory.version); // "1.5.0"

// 檢查能力
const canModifyNotion = memory.capabilities.modify_notion_data.status === 'verified';

// 檢查資料是否過期
function isStale(fetchedAt: string, ttlSeconds: number): boolean {
  const age = (Date.now() - new Date(fetchedAt).getTime()) / 1000;
  return age > ttlSeconds;
}

const isPricingStale = isStale(
  memory.courses[0].pricing.fetched_at,
  memory.metadata.ttl.pricing
);
```

## 記憶結構

### 元資料 (Metadata)

```json
{
  "version": "1.5.0",
  "metadata": {
    "created_at": "2025-11-02T07:09:06.874Z",
    "last_updated": "2025-11-02T07:09:06.874Z",
    "ttl": {
      "courses": 3600,      // 1 小時
      "pricing": 1800,      // 30 分鐘
      "images": 86400,      // 24 小時
      "visual_analysis": 604800  // 7 天
    }
  }
}
```

### 課程資料 (Course Data)

每個課程包含以下時間戳記：
- `course.fetched_at` - 課程整體資料抓取時間
- `course.pricing.fetched_at` - 定價資料抓取時間
- `course.images.fetched_at` - 圖片資料抓取時間
- `course.metadata.fetched_at` - 元資料抓取時間

### 能力驗證 (Capabilities)

```json
{
  "capabilities": {
    "read_notion_data": {
      "status": "verified",
      "verified_at": "2025-11-02T07:09:06.874Z",
      "confidence": 100,
      "test_method": "成功讀取 21 個課程資料",
      "test_result": "成功從 Notion 讀取完整課程資料..."
    }
  }
}
```

狀態值：
- `verified` - 已驗證並成功
- `theoretical` - 理論上可行但未測試
- `unverified` - 未驗證
- `testing` - 測試中

## 統計資料

當前記憶包含：
- 總課程數: 21
- 已發布課程: 6
- 精選課程: 6
- 總圖片: 140
- 平均每課程 5.7 個 Highlight
- 價格範圍: 2500 - 45000 TWD

## 下一步計畫

### Phase 1.5.1: 視覺記憶分析
1. 實作圖片視覺分析 (使用 Claude Vision API)
2. 為每張圖片添加 `visual_analysis` 區塊
3. 更新 `analyze_images` 能力狀態為 `verified`

### Phase 1.5.2: Notion 修改驗證
1. 建立測試腳本修改 Notion 定價
2. 驗證網站自動更新機制
3. 記錄測試結果
4. 更新 `modify_notion_data` 和 `verify_website_update` 能力狀態

### Phase 2.0: 自動化運營
1. 定期自動更新記憶
2. 異常檢測 (價格異常、圖片失效)
3. 自動報告生成
4. 與其他 Persona 整合

## 維護建議

1. **定期更新**
   - 定價資料建議每 30 分鐘更新一次
   - 課程資料建議每 1 小時更新一次
   - 圖片資料建議每 24 小時檢查一次

2. **監控指標**
   - 記憶年齡
   - 過期資料數量
   - 能力驗證狀態
   - API 呼叫成功率

3. **錯誤處理**
   - 檢查 Notion API token 有效性
   - 驗證資料庫 ID 正確性
   - 監控 API 限流

## 技術規格

- Node.js 版本: 20+
- TypeScript: 5.x
- Notion API: v2023-10-31
- 記憶檔案大小: ~498KB
- 平均建構時間: ~10-15 秒 (21 個課程)

## 相關文件

- [Phase 1.5 需求文件](../../specs/curator-personas-memory-system-reads-course-data-f/requirements.md)
- [Notion API 文件](https://developers.notion.com/)
- [網站架構說明](../../../README.md)
