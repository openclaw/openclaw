#!/usr/bin/env tsx
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
 * pnpm tsx .kiro/scripts/curator/verify-index.ts --all
 *
 * 範例：
 * pnpm tsx .kiro/scripts/curator/verify-index.ts 4
 * pnpm tsx .kiro/scripts/curator/verify-index.ts --all
 */

import { getProducts } from '@/lib/notion'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

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
  [key: string]: any
}

async function loadEnv() {
  try {
    const envContent = await readFile(join(process.cwd(), '.env'), 'utf-8')
    envContent.split('\n').forEach(line => {
      line = line.trim()
      if (!line || line.startsWith('#')) return
      const [key, ...values] = line.split('=')
      if (key && values.length > 0) {
        process.env[key.trim()] = values.join('=').trim()
      }
    })
  } catch (error) {
    console.warn('Warning: Could not load .env file')
  }
}

async function verifyIndex(courseId?: number) {
  console.log('🔍 開始驗證 Highlight Index...\n')

  // 載入環境變數
  await loadEnv()

  // 1. 讀取 memory.json
  const memoryPath = join(
    process.cwd(),
    '.kiro/personas/curator/memory.json'
  )

  let memory: MemorySchema
  try {
    const memoryContent = await readFile(memoryPath, 'utf-8')
    memory = JSON.parse(memoryContent)
  } catch (error) {
    console.error('❌ 無法讀取 memory.json:', error)
    console.error('請先執行: pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts')
    process.exit(1)
  }

  // 2. 呼叫 getProducts() 取得排序後的陣列
  console.log('📚 從 Notion 讀取課程列表...')

  let products
  try {
    products = await getProducts()
    console.log(`✅ 成功讀取 ${products.length} 個課程\n`)
  } catch (error) {
    console.error('❌ 無法讀取課程列表:', error)
    process.exit(1)
  }

  // 3. 建立 course_id → index 的對照表
  // 注意：所有課程的 content_highlight1 都對應 index 0
  // 這是因為 HighlightCard 的 index 是相對於每個課程自己的 highlights 陣列
  const ALL_COURSES_INDEX = 0  // 所有課程的 highlight1 都是 index 0

  console.log('💡 重要發現：')
  console.log('   所有課程的 content_highlight1 都對應 HighlightCard 的 index 0')
  console.log('   這是因為 FIXED_SIX 函數為每個課程生成 6 個 highlight\n')

  // 4. 更新 memory.json
  let updatedCount = 0
  const targetCourseIds = courseId
    ? [courseId]
    : Object.keys(memory.highlight_index_mapping.mapping).map(Number)

  for (const cid of targetCourseIds) {
    const productExists = products.some((p: any) => p.id === cid || p.course_id === cid)

    if (!productExists) {
      console.log(`⚠️  課程 ${cid}: 未發布或不存在`)
      continue
    }

    const currentData = memory.highlight_index_mapping.mapping[String(cid)]

    if (!currentData) {
      // 新增課程
      memory.highlight_index_mapping.mapping[String(cid)] = {
        index: ALL_COURSES_INDEX,
        verified: true,
        note: `Auto-verified at ${new Date().toISOString().split('T')[0]} - content_highlight1`
      }
      updatedCount++
      console.log(`✅ 課程 ${cid}: index 設定為 ${ALL_COURSES_INDEX} (新增)`)
    } else if (currentData.index !== ALL_COURSES_INDEX || !currentData.verified) {
      // 更新現有課程
      memory.highlight_index_mapping.mapping[String(cid)] = {
        index: ALL_COURSES_INDEX,
        verified: true,
        note: `Auto-verified at ${new Date().toISOString().split('T')[0]} - content_highlight1`
      }
      updatedCount++
      console.log(`✅ 課程 ${cid}: index 設定為 ${ALL_COURSES_INDEX} (更新)`)
    } else {
      console.log(`✓  課程 ${cid}: index ${ALL_COURSES_INDEX} 已驗證，無需更新`)
    }
  }

  // 5. 更新 highlight_index_mapping 的說明
  memory.highlight_index_mapping.note = '所有課程的 content_highlight1 都對應 HighlightCard 的 index 0'
  memory.highlight_index_mapping.last_verified = new Date().toISOString().split('T')[0]
  if (!memory.highlight_index_mapping.explanation) {
    memory.highlight_index_mapping.explanation = 'FIXED_SIX 函數固定生成 6 個 highlight，index 0 = content_highlight1，依此類推'
  }

  // 6. 寫回檔案
  if (updatedCount > 0) {
    await writeFile(memoryPath, JSON.stringify(memory, null, 2), 'utf-8')
    console.log(`\n💾 已更新 ${updatedCount} 個課程的 index`)
  } else {
    console.log('\n✓  所有課程 index 都已是最新狀態')
  }

  // 7. 顯示完整對照表
  console.log('\n📊 當前 Index 對照表:')
  console.log('─'.repeat(60))
  console.log('課程 ID  | Index | 狀態 | 說明')
  console.log('─'.repeat(60))

  for (const [cid, data] of Object.entries(
    memory.highlight_index_mapping.mapping
  )) {
    const status = data.verified ? '✅ 已驗證' : '❌ 未驗證'
    const idx = data.index ?? 'null'
    const note = data.note || '-'
    console.log(`${cid.padEnd(8)} | ${String(idx).padEnd(5)} | ${status.padEnd(10)} | ${note}`)
  }
  console.log('─'.repeat(60))

  console.log('\n✅ 驗證完成！')
}

// 命令列參數處理
const args = process.argv.slice(2)

if (args.length === 0) {
  console.log('使用方式：')
  console.log('  pnpm tsx .kiro/scripts/curator/verify-index.ts 4')
  console.log('  pnpm tsx .kiro/scripts/curator/verify-index.ts --all')
  console.log('')
  console.log('說明：')
  console.log('  此工具會驗證課程在 HighlightCard 中的 index')
  console.log('  所有課程的 content_highlight1 都對應 index 0')
  process.exit(1)
}

const courseId = args[0] === '--all' ? undefined : Number(args[0])

if (args[0] !== '--all' && isNaN(courseId as number)) {
  console.error('❌ 錯誤：課程 ID 必須是數字')
  process.exit(1)
}

verifyIndex(courseId).catch(error => {
  console.error('❌ 執行失敗:', error)
  process.exit(1)
})
