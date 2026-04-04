import { Client } from '@notionhq/client';
import * as fs from 'fs';

// 手動讀取 .env.local
const envContent = fs.readFileSync('.env.local', 'utf-8');
const envLines = envContent.split('\n');
envLines.forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, '').replace(/\\n$/, '');
    process.env[key] = value;
  }
});

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const COURSE_6_PAGE_ID = '28805e9de121807aa596f976e32ae474';

async function updateCourse6ToPhysical() {
  try {
    console.log('🔄 開始更新第六課為實體課程...\n');

    const updateData = {
      page_id: COURSE_6_PAGE_ID,
      properties: {
        // 更新標題
        en_name: {
          title: [
            {
              text: {
                content: 'AI 全能實戰營',
              },
            },
          ],
        },
        zh_name: {
          rich_text: [
            {
              text: {
                content: 'AI 全能實戰營',
              },
            },
          ],
        },
        // 更新描述
        zh_description: {
          rich_text: [
            {
              text: {
                content: '三天實體密集培訓，從理論到實戰，打造你的 AI 自動化系統。手把手帶你建立屬於自己的 AI 數位勞工，讓 AI 成為你 24/7 運作的得力助手。小班制教學，確保每位學員都能真正掌握核心技能。',
              },
            },
          ],
        },
        en_description: {
          rich_text: [
            {
              text: {
                content: '三天實體密集培訓，從理論到實戰，打造你的 AI 自動化系統。手把手帶你建立屬於自己的 AI 數位勞工，讓 AI 成為你 24/7 運作的得力助手。小班制教學，確保每位學員都能真正掌握核心技能。',
              },
            },
          ],
        },
        // 更新 Bar 區塊內容
        bar_text_1: {
          rich_text: [
            {
              text: {
                content: '📅 11/29, 12/6, 12/13',
              },
            },
          ],
        },
        bar_text_2: {
          rich_text: [
            {
              text: {
                content: '📍 板橋區公所旁',
              },
            },
          ],
        },
        bar_text_3: {
          rich_text: [
            {
              text: {
                content: '👥 限額 12 人',
              },
            },
          ],
        },
        bar_text_4: {
          rich_text: [
            {
              text: {
                content: '⏰ 截止 11/24',
              },
            },
          ],
        },
        // 更新學習內容
        you_will_learn: {
          rich_text: [
            {
              text: {
                content: `✓ 第一天：AI 基礎建設與環境配置
  - 建立完整的 AI 開發環境
  - 掌握 ChatGPT API 串接技術
  - 設計你的第一個 AI 助理

✓ 第二天：自動化工作流程實戰
  - 瀏覽器自動化技術
  - AI 排程與任務管理
  - 打造 24/7 運行的數位勞工

✓ 第三天：專案實作與部署
  - 完成個人專案交付
  - 系統部署與維護
  - 持續優化策略`,
              },
            },
          ],
        },
        // 更新課程總結
        summery: {
          rich_text: [
            {
              text: {
                content: '這是一場從零到一的 AI 實戰訓練營。三天 21 小時的密集培訓，你將親手打造出一個能夠自動執行任務的 AI 系統。我們不只教理論，更注重實際動手操作。每位學員都會在課程中完成一個真實專案，並學會如何持續優化你的 AI 助理。小班制確保講師能夠照顧到每一位學員的學習進度。',
              },
            },
          ],
        },
      },
    };

    console.log('📤 發送更新請求到 Notion...\n');

    const response = await notion.pages.update(updateData);

    console.log('✅ 更新成功！\n');

    // 儲存更新後的資料
    const outputPath = '.kiro/personas/curator/course-6-updated.json';
    fs.writeFileSync(outputPath, JSON.stringify(response, null, 2));
    console.log(`💾 更新結果已儲存到: ${outputPath}\n`);

    // 顯示更新摘要
    console.log('📋 更新摘要：');
    console.log('─────────────────────────────────────');
    console.log('✓ 課程標題：人生駭客手冊 → AI 全能實戰營');
    console.log('✓ 課程描述：已更新為實體課程說明');
    console.log('✓ Bar 區塊 1：📅 11/29, 12/6, 12/13');
    console.log('✓ Bar 區塊 2：📍 板橋區公所旁');
    console.log('✓ Bar 區塊 3：👥 限額 12 人');
    console.log('✓ Bar 區塊 4：⏰ 截止 11/24');
    console.log('✓ 學習內容：已更新為三天課程規劃');
    console.log('─────────────────────────────────────\n');

  } catch (error: any) {
    console.error('❌ 更新失敗:', error.message);
    if (error.body) {
      console.error('詳細資訊:', JSON.stringify(error.body, null, 2));
    }
  }
}

updateCourse6ToPhysical();
