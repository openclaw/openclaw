#!/usr/bin/env tsx
/**
 * Curator Memory 刷新包裝腳本
 *
 * 確保環境變數在任何 import 之前載入
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

// 步驟 1: 載入環境變數
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
      }
    });
    console.log('✅ 環境變數已載入\n');
  } catch (error) {
    console.error('❌ 無法載入 .env:', error);
    process.exit(1);
  }
}

// 步驟 2: 動態 import 並執行 build-memory
async function run() {
  await loadEnv();

  // 動態 import 確保在環境變數載入後才執行
  const { buildCuratorMemory } = await import('./build-memory-v1.5.js');
  await buildCuratorMemory();
}

run().catch(error => {
  console.error('❌ 執行失敗:', error);
  process.exit(1);
});
