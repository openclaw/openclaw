/**
 * Memory Freshness Checker
 *
 * FR-3: Timeliness Management
 * 檢查記憶中的資料是否需要更新
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

interface MemoryMetadata {
  created_at: string;
  last_updated: string;
  ttl: {
    courses: number;
    pricing: number;
    images: number;
    visual_analysis: number;
  };
}

interface CourseWithTimestamps {
  course_id: number;
  zh_name: string;
  fetched_at: string;
  pricing: {
    fetched_at: string;
  };
  images: {
    fetched_at: string;
  };
  metadata: {
    fetched_at: string;
  };
}

/**
 * 檢查時間戳記是否過期
 */
function isStale(fetchedAt: string, ttlSeconds: number): boolean {
  const fetchedTime = new Date(fetchedAt).getTime();
  const now = Date.now();
  const ageSeconds = (now - fetchedTime) / 1000;

  return ageSeconds > ttlSeconds;
}

/**
 * 計算資料年齡
 */
function getAge(timestamp: string): string {
  const age = (Date.now() - new Date(timestamp).getTime()) / 1000;

  if (age < 60) return `${Math.floor(age)} 秒`;
  if (age < 3600) return `${Math.floor(age / 60)} 分鐘`;
  if (age < 86400) return `${Math.floor(age / 3600)} 小時`;
  return `${Math.floor(age / 86400)} 天`;
}

/**
 * 主函數
 */
async function checkMemoryFreshness() {
  console.log('🕐 檢查 Curator 記憶時效性...\n');

  // 讀取記憶檔案
  const memoryPath = join(process.cwd(), '.kiro/personas/curator/memory.json');
  const content = await readFile(memoryPath, 'utf-8');
  const memory = JSON.parse(content);

  const metadata: MemoryMetadata = memory.metadata;
  const courses: CourseWithTimestamps[] = memory.courses;

  // 檢查整體記憶年齡
  console.log('📊 整體記憶狀態:');
  console.log(`   版本: ${memory.version}`);
  console.log(`   建立時間: ${metadata.created_at}`);
  console.log(`   最後更新: ${metadata.last_updated}`);
  console.log(`   記憶年齡: ${getAge(metadata.last_updated)}\n`);

  // 檢查 TTL 設定
  console.log('⏱️  TTL 設定:');
  console.log(`   課程資料: ${metadata.ttl.courses} 秒 (${metadata.ttl.courses / 60} 分鐘)`);
  console.log(`   定價資料: ${metadata.ttl.pricing} 秒 (${metadata.ttl.pricing / 60} 分鐘)`);
  console.log(`   圖片資料: ${metadata.ttl.images} 秒 (${metadata.ttl.images / 3600} 小時)`);
  console.log(`   視覺分析: ${metadata.ttl.visual_analysis} 秒 (${metadata.ttl.visual_analysis / 86400} 天)\n`);

  // 檢查課程資料時效性
  console.log('🔍 課程資料時效性檢查:');
  let staleCourses = 0;
  let stalePricing = 0;
  let staleImages = 0;

  courses.forEach(course => {
    const courseStale = isStale(course.fetched_at, metadata.ttl.courses);
    const pricingStale = isStale(course.pricing.fetched_at, metadata.ttl.pricing);
    const imagesStale = isStale(course.images.fetched_at, metadata.ttl.images);

    if (courseStale) staleCourses++;
    if (pricingStale) stalePricing++;
    if (imagesStale) staleImages++;

    if (courseStale || pricingStale || imagesStale) {
      console.log(`\n   ⚠️  課程 ${course.course_id}: ${course.zh_name}`);
      if (courseStale) {
        console.log(`      - 課程資料已過期 (年齡: ${getAge(course.fetched_at)})`);
      }
      if (pricingStale) {
        console.log(`      - 定價資料已過期 (年齡: ${getAge(course.pricing.fetched_at)})`);
      }
      if (imagesStale) {
        console.log(`      - 圖片資料已過期 (年齡: ${getAge(course.images.fetched_at)})`);
      }
    }
  });

  // 摘要
  console.log('\n\n📋 摘要:');
  console.log(`   總課程數: ${courses.length}`);
  console.log(`   過期課程資料: ${staleCourses}`);
  console.log(`   過期定價資料: ${stalePricing}`);
  console.log(`   過期圖片資料: ${staleImages}`);

  if (staleCourses > 0 || stalePricing > 0 || staleImages > 0) {
    console.log('\n   🔄 建議執行: pnpm run curator:refresh');
    console.log('      或執行: .kiro/scripts/curator/run-v1.5.sh');
  } else {
    console.log('\n   ✅ 所有資料都是最新的！');
  }

  return {
    total: courses.length,
    stale: {
      courses: staleCourses,
      pricing: stalePricing,
      images: staleImages,
    },
    needs_refresh: staleCourses > 0 || stalePricing > 0 || staleImages > 0,
  };
}

// 執行
(async () => {
  const result = await checkMemoryFreshness();
  console.log('\n🎉 檢查完成！');

  // 返回非零退出碼如果需要更新
  process.exit(result.needs_refresh ? 1 : 0);
})().catch((error) => {
  console.error('❌ 錯誤:', error);
  process.exit(2);
});
