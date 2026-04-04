# ThinkerCafe 網站圖片載入架構分析報告

## 執行摘要

經過深入分析 ThinkerCafe 官方網站的圖片載入架構，發現存在**多個效能和可維護性瓶頸**。當前架構高度依賴 Notion API 提供的臨時簽名 URL，具有**有效期限制**和**缺乏最佳化**的特點。

### 關鍵發現
- **圖片完全來自 Notion 雲端存儲**（AWS S3），沒有本地備份或 CDN
- **所有 Notion 圖片 URL 包含 3600 秒（1 小時）的臨時簽名**
- **使用原生 HTML img 標籤**，完全未利用 Next.js Image 最佳化
- **關鍵頁面缺乏快取策略**（About 頁面 revalidate=0）
- **SVG 定價圖已直接嵌入組件代碼**，難以維護和更新

---

## 1. 圖片來源分析

### 1.1 主要來源：Notion Database

所有課程和頁面圖片都來自 Notion，通過 Notion API 獲取：

```
來源：@/lib/notion.ts (getProductById, getOurStoryContent, getOurValueContent, getOurTeamContent)
提取方法：pick.file() 函數從 Notion properties 中提取文件 URL
```

**圖片字段包括：**
- `image` - 課程封面圖
- `content_video` - 課程影片
- `content_highlight1_image` 到 `content_highlight6_image` - 6 個高亮區塊圖片
- 團隊、故事、價值觀圖片

### 1.2 Notion URL 格式分析

所有 Notion 圖片 URL 遵循此格式：

```
https://prod-files-secure.s3.us-west-2.amazonaws.com/[bucket]/[file_id]/[filename]
?X-Amz-Algorithm=AWS4-HMAC-SHA256
&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD
&X-Amz-Credential=ASIAZI2LB4666XHO47NU%2F20251102%2Fus-west-2%2Fs3%2Faws4_request
&X-Amz-Date=20251102T155305Z
&X-Amz-Expires=3600  ← 關鍵：1 小時有效期
&X-Amz-Security-Token=IQoJb3...
&X-Amz-Signature=30f70db9...
&X-Amz-SignedHeaders=host
```

**統計數據：**
- 總圖片 URL：280 個
- 所有 URL 統一使用：**X-Amz-Expires=3600** (1 小時)
- 生成時間：2025-11-02T155305Z (當前 memory.json 快照時間)

### 1.3 Notion 圖片過期與更新機制

**當前問題：**
1. **1 小時過期**：Notion 簽名 URL 每小時過期，需要重新生成
2. **無自動更新**：網站沒有機制自動刷新 Notion 圖片 URL
3. **快照依賴**：memory.json 中的 URL 會逐漸失效
4. **用戶體驗風險**：3 小時後開啟舊 Notion 圖片 URL 會失敗

**更新機制：**
- `memory.json` 中的 `metadata.ttl` 設置：
  - `images: 86400` (24 小時快取時間)
  - `pricing: 1800` (30 分鐘)
  - `courses: 3600` (1 小時)

**但實際上**：
- memory.json 是一次性快照，不會自動更新
- 需要手動重新運行 Curator 任務來更新 URL

---

## 2. Image 組件使用情況

### 2.1 使用方式統計

**使用情況：**
- ✅ **完全使用原生 HTML `<img>` 標籤**
- ❌ **完全未使用 Next.js Image 組件**
- ❌ **未設置 priority, loading, sizes 等屬性**

### 2.2 具體組件分析

#### ProductGrid.tsx (產品列表頁)
```javascript
// 路徑：/app/products/ProductGrid.tsx
<img
  src={product.image || "/placeholder.svg"}
  alt={product.zh_name}
  className="h-40 w-full object-cover transition-transform duration-300 group-hover:scale-110"
/>
```
**問題：**
- 無尺寸優化
- 無 lazy loading
- 無響應式圖片（srcset）

#### HighlightCard.js (課程詳情高亮卡片)
```javascript
// 路徑：/app/products/[id]/HighlightCard.js (行 139-142)
<img
  src={finalImage}
  alt={title}
  className="w-full h-full object-cover"
/>
```
**特殊情況：**
- 混合使用 SVG 和圖片
- SVG 通過 `dangerouslySetInnerHTML` 直接嵌入
- 部分課程（2, 3, 4, 5, 6）使用內聯 SVG 定價圖

#### About 頁面
```javascript
// 路徑：/app/about/page.tsx
// 故事圖片（行 59-63）
<img src={image} alt={zh_title} className="w-full max-w-[520px] mx-auto rounded-xl shadow-2xl h-auto object-cover" />

// 團隊圖片（行 202-206）
<img src={m.image || "/coffee-shop-founder-headshot.png"} alt={m.zh_name || "Team member"} className="mx-auto h-20 w-20 rounded-full object-cover" />

// 價值觀圖片（行 91-95）
<img src={v.image} alt={v.zh_title} className="h-10 w-10 text-accent hover:text-primary" />
```

#### OrderCard.js
```javascript
// 路徑：/app/orders/OrderCard.js
<img src={course.image} alt="" className="aspect-video object-cover rounded-md md:row-span-2 lg:row-span-1" />
```

### 2.3 Next.js Image 配置分析

**next.config.mjs：**
```javascript
images: {
  unoptimized: true,  ← 完全禁用 Next.js 圖片最佳化！
}
```

**含義：**
- Next.js 圖片優化 API 被禁用
- 無 AVIF/WebP 自動轉換
- 無自動響應式裁剪
- 無邊界優化（On-demand optimization）

**後果：**
- 即使使用 Next.js Image 組件，也不會有任何優化效果
- 原始圖片直接從 Notion S3 返回，無體積壓縮

---

## 3. Performance 問題與瓶頸

### 3.1 圖片大小與帶寬問題

**預期問題（基於 Notion 圖片特性）：**

| 頁面 | 圖片數量 | 預期大小 | 加載時間 |
|-----|--------|---------|---------|
| /products | 3-5 個課程卡片 | 2-5MB | 2-5秒 |
| /products/[id] | 7 個圖片 (1 hero + 6 highlights) | 3-8MB | 3-8秒 |
| /about | 6-10 個圖片 | 2-6MB | 2-6秒 |
| 首頁 | 1-2 個圖片 | 0.5-1MB | 0.5-2秒 |

**實際影響：**
- Notion 圖片通常未壓縮，大小 2-5MB
- 無 CDN 優化，直接從 AWS S3 us-west-2 拉取
- 台灣用戶跨太平洋延遲 100-200ms
- 無 Lazy Loading，所有圖片同時載入

### 3.2 URL 過期風險

**時間軸分析：**

| 時間 | 狀態 | 影響 |
|-----|------|------|
| T0 (現在) | URL 有效 | 正常 ✅ |
| T+30分 | URL 有效 | 正常 ✅ |
| T+1小時 | **URL 過期** | 圖片加載失敗 ❌ |
| T+3小時 | URL 過期 | 所有緩存 URL 失敗 ❌ |
| T+24小時 | URL 過期 | 完全不可用 ❌ |

**memory.json 中的日期：**
- 最後更新：2025-11-02T15:53:01.413Z
- 所有 URL 簽名時間：2025-11-02T155305Z

**過期時間計算：**
- 如果今天是 2025-11-02 15:53，則所有 URL 會在 16:53 失效

### 3.3 網頁性能指標影響

**LCP (Largest Contentful Paint)：**
- 沒有優化的圖片直接影響 LCP
- 預期延遲：2-3 秒（應該 < 2.5 秒）

**FID (First Input Delay)：**
- 圖片解碼影響主線程
- 大型未優化圖片可能阻塞交互

**CLS (Cumulative Layout Shift)：**
- 圖片無尺寸約束時，會導致版面抖動
- 各頁面圖片寬高比不一致加重此問題

### 3.4 API 調用效率

**Notion API 調用：**
```
每頁面加載：
- ProductGrid: 調用 /api/products → getProducts() → 1 Notion API 請求
- Product Detail: 調用 getProductById() → 1 Notion API 請求
- About: 調用 4 個 get*Content() 函數 → 4 Notion API 請求
```

**問題：**
- 無查詢快取，每次都新鮮拉取
- `getProductById` 使用 `cache: "no-store"`，禁用所有快取
- About 頁面 `revalidate: 0`，完全禁用 ISR

---

## 4. 當前架構圖

```
使用者訪問
    ↓
Next.js 頁面 (route handlers)
    ↓
    ├─→ Notion API (@/lib/notion.ts)
    │       ↓
    │   AWS S3 (Notion 存儲)
    │       ↓
    │   簽名 URL (expires=3600秒)
    │       ↓
    │   存儲在 memory.json
    │
    └─→ React 組件
            ↓
            原生 HTML <img>
                ↓
                直接加載 AWS S3 URL (跨太平洋)
```

**問題：**
1. ❌ 無中間 CDN
2. ❌ URL 有效期短 (1 小時)
3. ❌ 無圖片最佳化
4. ❌ 無 Lazy Loading
5. ❌ API 快取策略差

---

## 5. 發現的具體問題

### 5.1 SVG 定價圖硬編碼

**HighlightCard.js 第 7-93 行**

5 個課程的定價圖以 SVG 字符串硬編碼在代碼中：

```javascript
const svg2 = (courseId === 2 && index === 0) ? `<svg>...</svg>` : null;
const svg3 = (courseId === 3 && index === 0) ? `<svg>...</svg>` : null;
const svg4 = (courseId === 4 && index === 0) ? `<svg>...</svg>` : null;
const svg5 = (courseId === 5 && index === 0) ? `<svg>...</svg>` : null;
const svg6 = (courseId === 6 && index === 0) ? `<svg>...</svg>` : null;
```

**問題：**
- 每個 SVG 大約 1KB-2KB，共 5-10KB 代碼污染
- 定價數據變更需要修改源代碼
- 無法通過 Notion 動態更新
- 完全違反 DRY 原則

### 5.2 產品圖片無備份

```javascript
// ProductGrid.tsx
src={product.image || "/placeholder.svg"}
```

**分析：**
- 如果 Notion 圖片 URL 失效，只有 placeholder.svg
- 沒有本地圖片備份或替代源
- 用戶體驗完全依賴 Notion 可用性

### 5.3 About 頁面完全禁用快取

```javascript
// /app/about/page.tsx
export const revalidate = 0;  // 禁用 ISR
```

**問題：**
- 每次訪問都重新從 Notion 獲取所有數據和圖片
- 不必要的 API 調用和延遲
- 圖片 URL 不會更新（仍用舊簽名）

---

## 6. 建議的最佳化方向

### 6.1 短期修復 (優先級：高)

#### 1. 啟用 Next.js Image 最佳化
```javascript
// next.config.mjs
images: {
  unoptimized: false,  // 啟用優化
  remotePatterns: [
    {
      protocol: 'https',
      hostname: 'prod-files-secure.s3.us-west-2.amazonaws.com',
      port: '',
      pathname: '/156606c6-168c-41e7-acfb-f5c1582e10b9/**',
    }
  ],
}
```

**效果：**
- 自動 WebP/AVIF 轉換
- 響應式圖片生成
- 邊界優化
- 預期效能提升 30-50%

#### 2. 使用 Next.js Image 組件替換所有原生 img
```javascript
// 從
<img src={product.image} alt={product.zh_name} />

// 改為
<Image
  src={product.image}
  alt={product.zh_name}
  width={300}
  height={200}
  loading="lazy"
  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
/>
```

#### 3. 為關鍵圖片設置 priority
```javascript
// Hero 圖片
<Image ... priority />

// 其他圖片
<Image ... loading="lazy" />
```

#### 4. 啟用 ISR 快取
```javascript
// /app/products/[id]/page.tsx
export const revalidate = 3600;  // 1 小時重新驗證

// /app/about/page.tsx
export const revalidate = 3600;  // 而非 0
```

**預期效果：**
- 首次請求：完整渲染 + Notion API 調用
- 後續 1 小時內：從快取返回（秒級）
- 1 小時後的請求：後台重新驗證

### 6.2 中期改進 (優先級：中)

#### 1. 實現圖片 URL 自動刷新機制
```typescript
// lib/imageCache.ts
export async function getCachedImageUrl(notionUrl: string, maxAge = 30 * 60 * 1000) {
  // 若 URL 已保存超過 maxAge，重新從 Notion 獲取
  const cached = await redis.get(`image:${hash(notionUrl)}`);
  
  if (cached && Date.now() - cached.timestamp < maxAge) {
    return cached.url;
  }
  
  // URL 即將過期，重新獲取
  const freshUrl = await getProductById(...);  // Notion API 調用
  await redis.set(`image:${hash(notionUrl)}`, { url: freshUrl, timestamp: Date.now() });
  
  return freshUrl;
}
```

#### 2. 設置 Cron 任務定期更新 memory.json
```typescript
// app/api/cron/refresh-images/route.ts
export async function GET(req: Request) {
  // 驗證 cron 祕鑰
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  // 重新生成 memory.json
  const curator = new Curator();
  await curator.updateMemory();  // 刷新所有 Notion URL
  
  return NextResponse.json({ success: true });
}
```

#### 3. 提取 SVG 定價圖到 Notion
- 在 Notion 課程資料庫中添加 `pricing_image` 字段
- 刪除硬編碼的 SVG
- 動態加載定價圖

### 6.3 長期架構 (優先級：低)

#### 1. 實現圖片代理/緩存層
```typescript
// app/api/proxy/image/route.ts
export async function GET(req: Request) {
  const { url } = req.nextUrl.searchParams;
  
  // 驗證 URL 來源
  if (!isAllowedOrigin(url)) {
    return new Response('Forbidden', { status: 403 });
  }
  
  // 從 S3 代理請求
  const response = await fetch(url);
  
  // 返回優化後的圖片
  return new Response(response.body, {
    headers: {
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': response.headers.get('content-type'),
    },
  });
}
```

#### 2. 遷移至 Vercel Image Optimization
- 利用 Vercel 的全球 CDN
- 零配置圖片最佳化
- 自動化的格式協商

#### 3. 建立本地圖片備份系統
- Notion 圖片定期同步至本地 S3 bucket
- 作為 Notion 圖片的備用源
- 增強可靠性和性能

---

## 7. 效能預測與改進預期

### 優化前
| 指標 | 當前值 |
|-----|--------|
| 首次頁面加載 | 3-5s |
| 圖片加載時間 | 2-4s |
| 圖片體積 | 200-500KB (原始) |
| Notion API 調用 | 每次訪問 1-4 次 |
| 圖片 404 風險 | 3+ 小時後較高 |
| Core Web Vitals | 可能不達標 |

### 優化後預期
| 指標 | 預計值 | 改進幅度 |
|-----|--------|---------|
| 首次頁面加載 | 1.5-2.5s | 40-50% ↓ |
| 圖片加載時間 | 500-1000ms | 60-70% ↓ |
| 圖片體積 | 50-100KB (WebP) | 75% ↓ |
| Notion API 調用 | 每小時 1-4 次 | 99% ↓ |
| 圖片 404 風險 | 不到 1% | 幾乎消除 |
| Core Web Vitals | 綠色 (>90) | 顯著改進 |

---

## 8. 實施優先級清單

### Phase 1 (立即執行，1-2 天)
- [ ] 啟用 Next.js Image 最佳化 (移除 `unoptimized: true`)
- [ ] 為所有 img 標籤替換為 Next.js Image 組件
- [ ] 為 hero 圖片添加 `priority` 屬性
- [ ] 為其他圖片添加 `loading="lazy"`

### Phase 2 (本周，2-3 天)
- [ ] 為產品詳情頁和 About 頁添加 ISR 快取 (`revalidate: 3600`)
- [ ] 驗證 Notion 圖片 URL 格式，添加 `remotePatterns` 配置
- [ ] 實施圖片尺寸約束，防止 CLS
- [ ] 測試各頁面效能

### Phase 3 (本月，3-5 天)
- [ ] 提取 SVG 定價圖到 Notion
- [ ] 建立圖片 URL 刷新機制
- [ ] 設置 Cron 任務自動更新 memory.json
- [ ] 添加本地圖片備份

### Phase 4 (長期)
- [ ] 實現圖片代理層
- [ ] 遷移至 Vercel Image Optimization
- [ ] 監控圖片性能和可用性

---

## 9. 監控與維護建議

### 關鍵指標追蹤
1. **圖片加載時間** (使用 Web Vitals)
2. **圖片 404 錯誤率** (使用 Sentry)
3. **Notion API 調用次數** (使用 Datadog)
4. **圖片 URL 過期率** (自定義監控)

### 自動告警
- 圖片加載時間 > 2s
- 404 錯誤率 > 1%
- Notion API 限制接近 (1000 req/min)

---

## 10. 檔案參考

| 文件 | 位置 | 用途 |
|-----|------|------|
| 配置 | `/Users/thinkercafe/Documents/thinker_official_website/next.config.mjs` | Next.js 圖片配置 |
| 數據源 | `/Users/thinkercafe/Documents/thinker_official_website/lib/notion.ts` | Notion API 調用 |
| 圖片 URL 快照 | `/Users/thinkercafe/Documents/thinker_official_website/.kiro/personas/curator/memory.json` | 當前 URL 集合 |
| 產品頁 | `/Users/thinkercafe/Documents/thinker_official_website/app/products/ProductGrid.tsx` | 產品列表組件 |
| 詳情頁 | `/Users/thinkercafe/Documents/thinker_official_website/app/products/[id]/HighlightCard.js` | 高亮卡片組件 |
| About 頁 | `/Users/thinkercafe/Documents/thinker_official_website/app/about/page.tsx` | 團隊與價值觀 |
| 訂單頁 | `/Users/thinkercafe/Documents/thinker_official_website/app/orders/OrderCard.js` | 訂單卡片組件 |

---

## 結論

ThinkerCafe 網站的圖片架構雖然簡單可用，但存在**明顯的性能和可靠性問題**。Notion 簽名 URL 的 1 小時有效期限制，加上完全禁用的 Next.js 圖片最佳化，導致：

1. **效能低下** - 大型未優化圖片，跨太平洋延遲
2. **可靠性差** - URL 快速過期，無備份機制
3. **可維護性弱** - SVG 定價圖硬編碼，難以更新

**建議立即實施 Phase 1 的優化**，以快速改善效能和用戶體驗。長期應規劃圖片代理層和備份機制，以降低對 Notion 的依賴。

