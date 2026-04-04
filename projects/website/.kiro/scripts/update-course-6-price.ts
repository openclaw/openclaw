import { Client } from '@notionhq/client';
import * as fs from 'fs';

// 手動讀取 .env
const envContent = fs.readFileSync('.env', 'utf-8');
const envLines = envContent.split('\n');
envLines.forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    process.env[key] = value;
  }
});

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const COURSE_6_PAGE_ID = '28805e9de121807aa596f976e32ae474';

async function updateCourse6Price() {
  try {
    console.log('🔄 更新第六課價格...\n');

    const updateData = {
      page_id: COURSE_6_PAGE_ID,
      properties: {
        // 更新價格
        single_price: {
          number: 20768,
        },
        single_price_early: {
          number: 10000,
        },
      },
    };

    console.log('📤 發送更新請求到 Notion...\n');
    const response = await notion.pages.update(updateData);

    console.log('✅ 價格更新成功！\n');
    console.log('📋 新價格：');
    console.log('─────────────────────────────────────');
    console.log('  原價：NT$ 20,768');
    console.log('  優惠價：NT$ 10,000');
    console.log('  節省：NT$ 10,768');
    console.log('─────────────────────────────────────\n');

  } catch (error: any) {
    console.error('❌ 更新失敗:', error.message);
    if (error.body) {
      console.error('詳細資訊:', JSON.stringify(error.body, null, 2));
    }
  }
}

updateCourse6Price();
