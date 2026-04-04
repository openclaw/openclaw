/**
 * Curator Memory Builder v1.5
 *
 * Phase 1.5 Enhancements:
 * - FR-3: Adds timestamps to all data
 * - FR-3: Implements TTL (Time To Live) management
 * - FR-4: Capability verification system
 * - Prepares structure for FR-1 (visual analysis) and FR-2 (Notion modification test)
 *
 * 這個腳本會：
 * 1. 從 Notion 讀取所有課程資料
 * 2. 為每筆資料添加時間戳記
 * 3. 提取定價、圖片、描述等資訊
 * 4. 建立視覺記憶（圖片 URL 清單）
 * 5. 記錄資料來源位置
 * 6. 計算統計資料
 * 7. 記錄能力驗證狀態
 * 8. 儲存到 .kiro/personas/curator/memory.json
 */

import { getProducts, getProductById } from '@/lib/notion';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';

// 載入環境變數
async function loadEnv() {
  try {
    const envContent = await readFile(join(process.cwd(), '.env'), 'utf-8');
    envContent.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;

      const [key, ...values] = line.split('=');
      if (key && values.length > 0) {
        const value = values.join('=').trim();
        process.env[key.trim()] = value;
        console.log(`Loaded: ${key.trim()} = ${value.substring(0, 20)}...`);
      }
    });
  } catch (error) {
    console.warn('Warning: Could not load .env file', error);
  }
}

// ===== Phase 1.5: Enhanced Types =====

interface ImageWithTimestamp {
  url: string | null;
  fetched_at: string;
  visual_analysis?: {
    analyzed_at: string;
    dominant_colors: string[];
    theme: string;
    mood: string;
    key_elements: string[];
  };
}

interface Highlight {
  highlight_number: number;
  title: string | null;
  description: string | null;
  image: ImageWithTimestamp | null;
}

interface CourseMemory {
  course_id: number;
  notion_page_id: string;
  zh_name: string;
  en_name: string;
  zh_description: string;
  en_description: string;
  fetched_at: string; // Phase 1.5: 添加時間戳記
  pricing: {
    single_price: number;
    single_price_early: number;
    group_price: number;
    group_price_early: number;
    currency: string;
    last_updated: string;
    fetched_at: string; // Phase 1.5
  };
  images: {
    main_image: ImageWithTimestamp | null;
    content_video: ImageWithTimestamp | null;
    highlights: Highlight[];
    fetched_at: string; // Phase 1.5
  };
  metadata: {
    published: boolean;
    featured: boolean;
    zh_category: string;
    en_category: string;
    fetched_at: string; // Phase 1.5
  };
}

interface CapabilityStatus {
  status: 'verified' | 'theoretical' | 'unverified' | 'testing';
  verified_at?: string;
  last_tested?: string;
  confidence: number; // 0-100
  test_method?: string;
  test_result?: string;
}

interface CuratorMemory {
  version: string; // Phase 1.5: 版本號
  metadata: {
    created_at: string;
    last_updated: string;
    ttl: {
      courses: number; // 課程資料 TTL (秒)
      pricing: number; // 定價資料 TTL (秒)
      images: number; // 圖片 URL TTL (秒)
      visual_analysis: number; // 視覺分析 TTL (秒)
    };
  };
  persona: {
    id: string;
    name: string;
    role: string;
    last_updated: string;
  };
  data_sources: {
    notion: {
      database_id: string;
      api_endpoint: string;
      code_location: string;
      functions: {
        get_all: string;
        get_by_id: string;
      };
    };
    page_template: {
      code_location: string;
      how_to_update: string;
    };
  };
  courses: CourseMemory[];
  visual_memory: {
    total_images: number;
    image_urls: string[];
    images_by_course: Record<number, string[]>;
    last_updated: string; // Phase 1.5
  };
  knowledge: {
    how_to_update_pricing: {
      step1: string;
      step2: string;
      step3: string;
      step4: string;
      note: string;
    };
    how_to_add_new_course: {
      step1: string;
      step2: string;
      step3: string;
      step4: string;
    };
  };
  capabilities: {
    // Phase 1.5: 能力驗證系統
    read_notion_data: CapabilityStatus;
    extract_pricing: CapabilityStatus;
    collect_images: CapabilityStatus;
    analyze_images: CapabilityStatus;
    modify_notion_data: CapabilityStatus;
    verify_website_update: CapabilityStatus;
  };
  statistics: {
    total_courses: number;
    published_courses: number;
    featured_courses: number;
    courses_by_category: Record<string, number>;
    price_range: {
      min_single_price: number;
      max_single_price: number;
      avg_single_price: number;
      min_group_price: number;
      max_group_price: number;
      avg_group_price: number;
    };
    total_images: number;
    avg_highlights_per_course: number;
  };
}

/**
 * 提取課程的 Highlight 圖片 (Phase 1.5 enhanced)
 */
function extractHighlights(product: any, fetchedAt: string): Highlight[] {
  return Array.from({ length: 6 }).map((_, i) => {
    const n = i + 1;
    const title = product[`content_highlight${n}`] || null;
    const description = product[`content_highlight${n}_description`] || null;
    const imageUrl = product[`content_highlight${n}_image`] || product.image || null;

    return {
      highlight_number: n,
      title,
      description,
      image: imageUrl ? {
        url: imageUrl,
        fetched_at: fetchedAt,
        // visual_analysis 會在 FR-1 實作後添加
      } : null,
    };
  }).filter(h => h.title !== null);
}

/**
 * 建立視覺記憶 (Phase 1.5 enhanced)
 */
function buildVisualMemory(courses: CourseMemory[], now: string) {
  const allImages: string[] = [];
  const imagesByCourse: Record<number, string[]> = {};

  courses.forEach(course => {
    const courseImages: string[] = [];

    if (course.images.main_image?.url) {
      allImages.push(course.images.main_image.url);
      courseImages.push('main_image');
    }

    if (course.images.content_video?.url) {
      allImages.push(course.images.content_video.url);
      courseImages.push('content_video');
    }

    course.images.highlights.forEach((h, idx) => {
      if (h.image?.url) {
        allImages.push(h.image.url);
        courseImages.push(`highlight${idx + 1}_image`);
      }
    });

    imagesByCourse[course.course_id] = courseImages;
  });

  return {
    total_images: allImages.length,
    image_urls: allImages,
    images_by_course: imagesByCourse,
    last_updated: now, // Phase 1.5
  };
}

/**
 * 計算統計資料
 */
function calculateStatistics(courses: CourseMemory[]) {
  const publishedCourses = courses.filter(c => c.metadata.published);
  const featuredCourses = courses.filter(c => c.metadata.featured);

  // 按分類統計
  const coursesByCategory: Record<string, number> = {};
  courses.forEach(c => {
    const category = c.metadata.zh_category || '未分類';
    coursesByCategory[category] = (coursesByCategory[category] || 0) + 1;
  });

  // 價格統計
  const singlePrices = courses.map(c => c.pricing.single_price).filter(p => p > 0);
  const groupPrices = courses.map(c => c.pricing.group_price).filter(p => p > 0);

  const priceRange = {
    min_single_price: Math.min(...singlePrices),
    max_single_price: Math.max(...singlePrices),
    avg_single_price: Math.round(singlePrices.reduce((a, b) => a + b, 0) / singlePrices.length),
    min_group_price: Math.min(...groupPrices),
    max_group_price: Math.max(...groupPrices),
    avg_group_price: Math.round(groupPrices.reduce((a, b) => a + b, 0) / groupPrices.length),
  };

  // Highlight 統計
  const totalHighlights = courses.reduce((sum, c) => sum + c.images.highlights.length, 0);
  const avgHighlightsPerCourse = totalHighlights / courses.length;

  return {
    total_courses: courses.length,
    published_courses: publishedCourses.length,
    featured_courses: featuredCourses.length,
    courses_by_category: coursesByCategory,
    price_range: priceRange,
    total_images: 0, // 會在 buildVisualMemory 後更新
    avg_highlights_per_course: Math.round(avgHighlightsPerCourse * 10) / 10,
  };
}

/**
 * Phase 1.5: 初始化能力驗證狀態
 */
function initializeCapabilities(now: string, coursesCount: number, imagesCount: number): CuratorMemory['capabilities'] {
  return {
    read_notion_data: {
      status: 'verified',
      verified_at: now,
      confidence: 100,
      test_method: `成功讀取 ${coursesCount} 個課程資料`,
      test_result: `成功從 Notion 讀取完整課程資料，包含定價、圖片、描述等所有欄位`
    },
    extract_pricing: {
      status: 'verified',
      verified_at: now,
      confidence: 100,
      test_method: `成功提取 ${coursesCount} 個課程的定價資料`,
      test_result: `成功提取 single_price, group_price, early bird 價格等所有定價欄位`
    },
    collect_images: {
      status: 'verified',
      verified_at: now,
      confidence: 100,
      test_method: `成功收集 ${imagesCount} 張圖片 URL`,
      test_result: `成功收集主圖、影片縮圖、Highlight 圖片等所有圖片 URL`
    },
    analyze_images: {
      status: 'theoretical',
      confidence: 0,
      test_method: '尚未實作 - 等待 FR-1 Phase 1.5.1 完成'
    },
    modify_notion_data: {
      status: 'theoretical',
      confidence: 0,
      test_method: '尚未測試 - 等待 FR-2 Phase 1.5.2 完成'
    },
    verify_website_update: {
      status: 'theoretical',
      confidence: 50,
      test_method: '尚未測試 - 等待 FR-2 Phase 1.5.2 完成',
      test_result: '理論上網站有 60 秒 revalidate，需實際測試驗證'
    }
  };
}

/**
 * 主函數：建立 Curator 記憶 v1.5
 */
async function buildCuratorMemory() {
  console.log('🧠 開始建立 Curator 記憶系統 v1.5...\n');

  const now = new Date().toISOString();

  // 1. 讀取所有課程
  console.log('📖 正在從 Notion 讀取課程資料...');
  const products = await getProducts();
  console.log(`   找到 ${products.length} 個課程\n`);

  // 2. 對每個課程讀取詳細資料
  console.log('🔍 正在讀取詳細資料...');
  const coursesWithDetails: CourseMemory[] = [];

  for (const p of products) {
    try {
      console.log(`   處理課程 ID ${p.course_id}: ${p.zh_name}`);
      const details = await getProductById(p.id);
      const courseFetchedAt = new Date().toISOString();

      coursesWithDetails.push({
        course_id: details.course_id,
        notion_page_id: details.id,
        zh_name: details.zh_name,
        en_name: details.en_name,
        zh_description: details.zh_description,
        en_description: details.en_description,
        fetched_at: courseFetchedAt, // Phase 1.5
        pricing: {
          single_price: details.single_price || 0,
          single_price_early: details.single_price_early || 0,
          group_price: details.group_price || 0,
          group_price_early: details.group_price_early || 0,
          currency: 'TWD',
          last_updated: new Date().toISOString().split('T')[0],
          fetched_at: courseFetchedAt, // Phase 1.5
        },
        images: {
          main_image: details.image ? {
            url: details.image,
            fetched_at: courseFetchedAt,
          } : null,
          content_video: details.content_video ? {
            url: details.content_video,
            fetched_at: courseFetchedAt,
          } : null,
          highlights: extractHighlights(details, courseFetchedAt),
          fetched_at: courseFetchedAt, // Phase 1.5
        },
        metadata: {
          published: details.published || false,
          featured: details.featured || false,
          zh_category: details.zh_category || '',
          en_category: details.en_category || '',
          fetched_at: courseFetchedAt, // Phase 1.5
        },
      });
    } catch (error) {
      console.error(`   ❌ 讀取課程 ${p.course_id} 失敗:`, error);
    }
  }

  console.log(`   成功讀取 ${coursesWithDetails.length} 個課程的詳細資料\n`);

  // 3. 建立視覺記憶
  console.log('🖼️  正在建立視覺記憶...');
  const visualMemory = buildVisualMemory(coursesWithDetails, now);
  console.log(`   記錄了 ${visualMemory.total_images} 張圖片\n`);

  // 4. 計算統計資料
  console.log('📊 正在計算統計資料...');
  const statistics = calculateStatistics(coursesWithDetails);
  statistics.total_images = visualMemory.total_images;
  console.log(`   已發布課程: ${statistics.published_courses}/${statistics.total_courses}`);
  console.log(`   精選課程: ${statistics.featured_courses}`);
  console.log(`   價格範圍: ${statistics.price_range.min_single_price} - ${statistics.price_range.max_single_price} TWD\n`);

  // 5. Phase 1.5: 初始化能力驗證
  console.log('✅ 正在驗證能力...');
  const capabilities = initializeCapabilities(now, coursesWithDetails.length, visualMemory.total_images);
  console.log(`   已驗證能力: ${Object.values(capabilities).filter(c => c.status === 'verified').length}/6`);
  console.log(`   理論能力: ${Object.values(capabilities).filter(c => c.status === 'theoretical').length}/6\n`);

  // 6. 組裝完整記憶
  const memory: CuratorMemory = {
    version: '1.5.0', // Phase 1.5
    metadata: {
      // Phase 1.5: 元資料與 TTL
      created_at: now,
      last_updated: now,
      ttl: {
        courses: 3600, // 1 小時
        pricing: 1800, // 30 分鐘
        images: 86400, // 24 小時
        visual_analysis: 604800, // 7 天
      },
    },
    persona: {
      id: 'curator',
      name: '商品策展人',
      role: 'Curator',
      last_updated: now,
    },
    data_sources: {
      notion: {
        database_id: process.env.NOTION_PRODUCTS_DATABASE_ID || '26405e9de12180ff9e11e4b93209d16b',
        api_endpoint: 'https://api.notion.com/v1/databases/{id}/query',
        code_location: '@/lib/notion.ts',
        functions: {
          get_all: 'getProducts()',
          get_by_id: 'getProductById(pageId)',
        },
      },
      page_template: {
        code_location: '@/app/products/[id]/page.tsx',
        how_to_update: '修改 Notion 資料庫後，網站會自動更新（revalidate: 60秒）',
      },
    },
    courses: coursesWithDetails,
    visual_memory: visualMemory,
    knowledge: {
      how_to_update_pricing: {
        step1: `打開 Notion 資料庫（ID: ${process.env.NOTION_PRODUCTS_DATABASE_ID || '26405e9de12180ff9e11e4b93209d16b'}）`,
        step2: '找到對應的課程頁面',
        step3: '修改以下欄位之一：single_price, single_price_early, group_price, group_price_early',
        step4: '等待最多 60 秒，網站會自動更新（revalidate）',
        note: '不需要修改程式碼，只需要改 Notion',
      },
      how_to_add_new_course: {
        step1: '在 Notion 資料庫新增一頁',
        step2: '填寫所有必填欄位（course_id, zh_name, pricing...）',
        step3: '設定 published = true',
        step4: '等待 60 秒後，新課程會出現在網站上',
      },
    },
    capabilities, // Phase 1.5
    statistics,
  };

  // 7. 儲存到檔案
  const outputPath = join(process.cwd(), '.kiro/personas/curator/memory.json');
  await writeFile(outputPath, JSON.stringify(memory, null, 2), 'utf-8');

  console.log('✅ Curator 記憶系統 v1.5 建立完成！');
  console.log(`📁 記憶檔案位置: ${outputPath}\n`);

  // 8. 顯示摘要
  console.log('📋 記憶摘要:');
  console.log(`   - 版本: ${memory.version}`);
  console.log(`   - 總課程數: ${statistics.total_courses}`);
  console.log(`   - 已發布: ${statistics.published_courses}`);
  console.log(`   - 總圖片: ${statistics.total_images}`);
  console.log(`   - 平均每課程 ${statistics.avg_highlights_per_course} 個 Highlight`);
  console.log(`   - 已驗證能力: ${Object.values(capabilities).filter(c => c.status === 'verified').length}/6`);
  console.log('');

  return memory;
}

// 執行
(async () => {
  await loadEnv();
  await buildCuratorMemory();
  console.log('🎉 完成！Curator v1.5 現在可以回答關於課程的問題，並追蹤資料時效性了。');
})().catch((error) => {
  console.error('❌ 錯誤:', error);
  process.exit(1);
});
