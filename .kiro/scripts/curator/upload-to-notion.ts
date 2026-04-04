#!/usr/bin/env tsx

/**
 * 上傳檔案到 Notion 並更新頁面屬性
 *
 * 用法：
 *   pnpm tsx upload-to-notion.ts <file_path> <page_id> <property_name>
 *
 * 範例：
 *   pnpm tsx upload-to-notion.ts test-pricing-course5.png 28405e9d-e121-80ca-b731-d3861177c7e1 content_highlight1_image
 */

import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

// 載入環境變數
async function loadEnv() {
  try {
    const envContent = await fs.promises.readFile(path.join(process.cwd(), '.env'), 'utf-8');
    envContent.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;

      const [key, ...values] = line.split('=');
      if (key && values.length > 0) {
        const value = values.join('=').trim();
        process.env[key.trim()] = value;
      }
    });
  } catch (error) {
    console.warn('Warning: Could not load .env file', error);
  }
}

const NOTION_VERSION = "2022-06-28";

async function uploadToNotion(
  filePath: string,
  pageId: string,
  propertyName: string
) {
  // 載入環境變數
  await loadEnv();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;

  if (!NOTION_TOKEN) {
    console.error("❌ 錯誤：找不到 NOTION_TOKEN 環境變數");
    process.exit(1);
  }

  console.log("🚀 開始上傳檔案到 Notion");
  console.log("=" .repeat(60));
  console.log(`   檔案: ${filePath}`);
  console.log(`   頁面 ID: ${pageId}`);
  console.log(`   屬性名稱: ${propertyName}`);
  console.log("");

  // 檢查檔案是否存在
  if (!fs.existsSync(filePath)) {
    console.error(`❌ 檔案不存在: ${filePath}`);
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const fileStats = fs.statSync(filePath);
  const fileSizeInMB = fileStats.size / (1024 * 1024);

  console.log(`📄 檔案資訊:`);
  console.log(`   名稱: ${fileName}`);
  console.log(`   大小: ${fileSizeInMB.toFixed(2)} MB`);

  if (fileSizeInMB > 20) {
    console.error(`❌ 檔案過大：${fileSizeInMB.toFixed(2)} MB（限制 20 MB）`);
    process.exit(1);
  }

  console.log("");

  // 偵測 content type
  const contentType = fileName.endsWith('.png') ? 'image/png' :
                      fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg' :
                      fileName.endsWith('.svg') ? 'image/svg+xml' :
                      'application/octet-stream';

  console.log(`   Content-Type: ${contentType}`);
  console.log("");

  // ============================================
  // 步驟 1: 建立 File Upload Object
  // ============================================
  console.log("📝 [步驟 1/3] 建立 File Upload Object...");

  const createResponse = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: fileName,
      content_type: contentType,
    }),
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    console.error(`❌ 建立失敗 (${createResponse.status}):`);
    console.error(error);
    process.exit(1);
  }

  const fileUpload = await createResponse.json();
  console.log(`✅ File Upload Object 已建立`);
  console.log(`   ID: ${fileUpload.id}`);
  console.log(`   Status: ${fileUpload.status}`);
  console.log(`   Upload URL: ${fileUpload.upload_url}`);
  console.log(`   過期時間: ${fileUpload.expiry_time}`);
  console.log("");

  // ============================================
  // 步驟 2: 上傳檔案內容
  // ============================================
  console.log("📤 [步驟 2/3] 上傳檔案內容...");

  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), {
    filename: fileName,
    contentType: contentType,
  });

  // 使用 node-fetch 不支援 stream，需要用原生 http
  const https = await import('https');
  const uploadResponse: any = await new Promise((resolve, reject) => {
    formData.submit({
      protocol: 'https:',
      host: 'api.notion.com',
      path: `/v1/file_uploads/${fileUpload.id}/send`,
      method: 'POST',
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
      }
    }, (err, res) => {
      if (err) return reject(err);

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300,
          status: res.statusCode,
          json: () => JSON.parse(body),
          text: () => body,
        });
      });
    });
  });

  if (!uploadResponse.ok) {
    const error = uploadResponse.text();
    console.error(`❌ 上傳失敗 (${uploadResponse.status}):`);
    console.error(error);
    process.exit(1);
  }

  const uploadResult = uploadResponse.json();
  console.log(`✅ 檔案已上傳`);
  console.log(`   Status: ${uploadResult.status}`);
  console.log(`   Filename: ${uploadResult.filename}`);
  console.log(`   Content Length: ${uploadResult.content_length} bytes`);
  console.log("");

  // ============================================
  // 步驟 3: 附加到頁面屬性
  // ============================================
  console.log("🔗 [步驟 3/3] 更新頁面屬性...");

  const updateResponse = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        [propertyName]: {
          type: "files",
          files: [
            {
              type: "file_upload",
              file_upload: {
                id: fileUpload.id
              },
              name: fileName
            }
          ]
        }
      }
    }),
  });

  if (!updateResponse.ok) {
    const error = await updateResponse.text();
    console.error(`❌ 更新頁面失敗 (${updateResponse.status}):`);
    console.error(error);
    process.exit(1);
  }

  const updateResult = await updateResponse.json();
  console.log(`✅ 頁面屬性已更新`);
  console.log("");

  // ============================================
  // 完成
  // ============================================
  console.log("=" .repeat(60));
  console.log("🎉 上傳完成！");
  console.log("");
  console.log("📊 摘要:");
  console.log(`   檔案: ${fileName}`);
  console.log(`   大小: ${fileSizeInMB.toFixed(2)} MB`);
  console.log(`   Notion File ID: ${fileUpload.id}`);
  console.log(`   頁面 ID: ${pageId}`);
  console.log(`   屬性: ${propertyName}`);
  console.log("");
  console.log("⏱️  下一步:");
  console.log(`   1. 檢查 Notion 頁面是否更新`);
  console.log(`   2. 等待 60 秒（網站 revalidate 時間）`);
  console.log(`   3. 開啟網站驗證：https://www.thinker.cafe/products/5`);
  console.log("");
}

// 執行
const [, , filePath, pageId, propertyName] = process.argv;

if (!filePath || !pageId || !propertyName) {
  console.error("用法: pnpm tsx upload-to-notion.ts <file_path> <page_id> <property_name>");
  console.error("");
  console.error("範例:");
  console.error("  pnpm tsx upload-to-notion.ts test-pricing-course5.png 28405e9d-e121-80ca-b731-d3861177c7e1 content_highlight1_image");
  process.exit(1);
}

uploadToNotion(filePath, pageId, propertyName).catch(error => {
  console.error("執行失敗：", error);
  process.exit(1);
});
