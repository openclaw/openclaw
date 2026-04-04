/**
 * Visual Memory Analysis Script
 *
 * 這個腳本僅生成分析任務記錄檔
 * 實際的視覺分析由 claude CLI session 執行
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

interface ImageToAnalyze {
  course_id: number;
  course_name: string;
  image_type: 'main_image' | 'content_video' | 'highlight';
  image_url: string;
  highlight_number?: number;
  highlight_title?: string;
}

async function extractImagesToAnalyze(): Promise<ImageToAnalyze[]> {
  const memoryPath = join(process.cwd(), '.kiro/personas/curator/memory.json');
  const content = await readFile(memoryPath, 'utf-8');
  const memory = JSON.parse(content);

  const images: ImageToAnalyze[] = [];

  memory.courses.forEach((course: any) => {
    if (course.images.main_image?.url) {
      images.push({
        course_id: course.course_id,
        course_name: course.zh_name,
        image_type: 'main_image',
        image_url: course.images.main_image.url,
      });
    }

    if (course.images.content_video?.url) {
      images.push({
        course_id: course.course_id,
        course_name: course.zh_name,
        image_type: 'content_video',
        image_url: course.images.content_video.url,
      });
    }

    course.images.highlights.forEach((h: any) => {
      if (h.image?.url) {
        images.push({
          course_id: course.course_id,
          course_name: course.zh_name,
          image_type: 'highlight',
          image_url: h.image.url,
          highlight_number: h.highlight_number,
          highlight_title: h.title,
        });
      }
    });
  });

  return images;
}

async function main() {
  console.log('🎨 Curator 視覺記憶分析系統 - 準備階段\n');

  const images = await extractImagesToAnalyze();
  console.log(`找到 ${images.length} 張圖片需要分析\n`);

  const outputPath = join(process.cwd(), '.kiro/personas/curator/images-to-analyze.json');
  await writeFile(
    outputPath,
    JSON.stringify({ images, total: images.length, generated_at: new Date().toISOString() }, null, 2),
    'utf-8'
  );

  console.log(`📁 圖片清單已儲存到: ${outputPath}`);
  console.log(`\n提示: S3 URL 無法直接由 Read tool 讀取`);
  console.log(`建議: 標記為 content_type: "external_url"`);

  return {
    total_images: images.length,
    images_list_path: outputPath
  };
}

main().catch((error) => {
  console.error('❌ 錯誤:', error);
  process.exit(1);
});
