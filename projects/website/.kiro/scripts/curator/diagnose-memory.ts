#!/usr/bin/env tsx
/**
 * Curator 工具：記憶健康診斷
 *
 * 功能：
 * 1. 檢查 memory.json 是否存在且可讀取
 * 2. 驗證所有必要欄位是否存在
 * 3. 檢查所有 index 是否已驗證
 * 4. 檢查定價資料是否合理
 * 5. 產生健康報告
 *
 * 使用方式：
 * pnpm tsx .kiro/scripts/curator/diagnose-memory.ts
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

interface DiagnosticResult {
  status: 'healthy' | 'warning' | 'error'
  category: string
  message: string
  suggestion?: string
}

async function diagnoseMemory(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = []
  const memoryPath = join(
    process.cwd(),
    '.kiro/personas/curator/memory.json'
  )

  // 1. 檢查檔案是否存在
  if (!existsSync(memoryPath)) {
    results.push({
      status: 'error',
      category: 'File Access',
      message: '❌ memory.json 不存在',
      suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
    })
    return results
  }

  results.push({
    status: 'healthy',
    category: 'File Access',
    message: '✅ memory.json 存在且可讀取'
  })

  // 2. 讀取並解析 JSON
  let memory: any
  try {
    memory = JSON.parse(readFileSync(memoryPath, 'utf-8'))
    results.push({
      status: 'healthy',
      category: 'JSON Parsing',
      message: '✅ JSON 格式正確'
    })
  } catch (error) {
    results.push({
      status: 'error',
      category: 'JSON Parsing',
      message: `❌ JSON 解析失敗: ${error}`,
      suggestion: '請檢查 JSON 語法是否正確'
    })
    return results
  }

  // 3. 檢查必要欄位
  const requiredFields = [
    'version',
    'courses',
    'highlight_index_mapping'
  ]

  let missingFields = 0
  for (const field of requiredFields) {
    if (!(field in memory)) {
      results.push({
        status: 'error',
        category: 'Schema',
        message: `❌ 缺少必要欄位: ${field}`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
      })
      missingFields++
    }
  }

  if (missingFields === 0) {
    results.push({
      status: 'healthy',
      category: 'Schema',
      message: '✅ 所有必要欄位都存在'
    })
  }

  // 4. 檢查 courses 陣列
  if (Array.isArray(memory.courses)) {
    results.push({
      status: 'healthy',
      category: 'Courses',
      message: `✅ 共有 ${memory.courses.length} 個課程`
    })

    // 檢查每個課程的必要欄位
    const requiredCourseFields = [
      'course_id',
      'notion_page_id',
      'zh_name',
      'pricing'
    ]

    let coursesMissingFields = 0
    memory.courses.forEach((course: any, index: number) => {
      for (const field of requiredCourseFields) {
        if (!(field in course)) {
          coursesMissingFields++
        }
      }
    })

    if (coursesMissingFields > 0) {
      results.push({
        status: 'warning',
        category: 'Courses',
        message: `⚠️  有 ${coursesMissingFields} 個欄位缺失`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
      })
    } else {
      results.push({
        status: 'healthy',
        category: 'Courses',
        message: '✅ 所有課程都有完整的必要欄位'
      })
    }
  } else {
    results.push({
      status: 'error',
      category: 'Courses',
      message: '❌ courses 不是陣列',
      suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
    })
  }

  // 5. 檢查 highlight_index_mapping
  if (memory.highlight_index_mapping?.mapping) {
    const mapping = memory.highlight_index_mapping.mapping
    const totalCourses = Object.keys(mapping).length
    const nullIndexCount = Object.values(mapping).filter(
      (m: any) => m.index === null
    ).length
    const unverifiedCount = Object.values(mapping).filter(
      (m: any) => !m.verified
    ).length

    if (nullIndexCount > 0) {
      results.push({
        status: 'warning',
        category: 'Index Mapping',
        message: `⚠️  有 ${nullIndexCount} 個課程的 index 為 null`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/verify-index.ts --all'
      })
    }

    if (unverifiedCount > 0) {
      results.push({
        status: 'warning',
        category: 'Index Mapping',
        message: `⚠️  有 ${unverifiedCount} 個課程的 index 未驗證`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/verify-index.ts --all'
      })
    }

    if (nullIndexCount === 0 && unverifiedCount === 0) {
      results.push({
        status: 'healthy',
        category: 'Index Mapping',
        message: `✅ 所有 ${totalCourses} 個課程的 index 都已驗證`
      })
    }
  } else {
    results.push({
      status: 'error',
      category: 'Index Mapping',
      message: '❌ highlight_index_mapping.mapping 不存在',
      suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
    })
  }

  // 6. 檢查定價合理性
  if (Array.isArray(memory.courses)) {
    let pricingIssues = 0
    const issueDetails: string[] = []

    memory.courses.forEach((course: any) => {
      if (course.pricing) {
        const { single_price, single_price_early, group_price, group_price_early } =
          course.pricing

        // 檢查早鳥價是否低於原價
        if (single_price_early >= single_price) {
          pricingIssues++
          issueDetails.push(
            `課程 ${course.course_id}: 一對一早鳥價 (${single_price_early}) >= 原價 (${single_price})`
          )
        }
        if (group_price_early >= group_price) {
          pricingIssues++
          issueDetails.push(
            `課程 ${course.course_id}: 團班早鳥價 (${group_price_early}) >= 原價 (${group_price})`
          )
        }

        // 檢查一對一價格是否高於團班（如果都有的話）
        if (group_price > 0 && single_price < group_price) {
          pricingIssues++
          issueDetails.push(
            `課程 ${course.course_id}: 一對一價格 (${single_price}) < 團班價格 (${group_price})`
          )
        }

        // 檢查價格是否為負數
        if (single_price < 0 || single_price_early < 0 || group_price < 0 || group_price_early < 0) {
          pricingIssues++
          issueDetails.push(`課程 ${course.course_id}: 發現負數價格`)
        }
      }
    })

    if (pricingIssues > 0) {
      results.push({
        status: 'warning',
        category: 'Pricing',
        message: `⚠️  有 ${pricingIssues} 個定價異常\n    ${issueDetails.join('\n    ')}`,
        suggestion: '請檢查 Notion 資料庫中的價格設定'
      })
    } else {
      results.push({
        status: 'healthy',
        category: 'Pricing',
        message: '✅ 所有定價都在合理範圍內'
      })
    }
  }

  // 7. 檢查記憶更新時間
  if (memory.metadata?.last_updated) {
    const lastUpdated = new Date(memory.metadata.last_updated)
    const now = new Date()
    const hoursSinceUpdate = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60)

    if (hoursSinceUpdate > 24) {
      results.push({
        status: 'warning',
        category: 'Freshness',
        message: `⚠️  記憶已超過 ${Math.floor(hoursSinceUpdate)} 小時未更新`,
        suggestion: 'pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts'
      })
    } else if (hoursSinceUpdate > 1) {
      results.push({
        status: 'healthy',
        category: 'Freshness',
        message: `✅ 記憶更新於 ${Math.floor(hoursSinceUpdate * 60)} 分鐘前`
      })
    } else {
      results.push({
        status: 'healthy',
        category: 'Freshness',
        message: `✅ 記憶更新於 ${Math.floor(hoursSinceUpdate * 60)} 分鐘前（非常新鮮）`
      })
    }
  }

  return results
}

// 執行診斷並顯示報告
diagnoseMemory().then(results => {
  console.log('🏥 Curator 記憶健康診斷報告')
  console.log('='.repeat(70))
  console.log()

  const categories = [...new Set(results.map(r => r.category))]

  for (const category of categories) {
    console.log(`\n📋 ${category}`)
    console.log('-'.repeat(70))

    const categoryResults = results.filter(r => r.category === category)

    for (const result of categoryResults) {
      console.log(`   ${result.message}`)
      if (result.suggestion) {
        console.log(`   💡 建議: ${result.suggestion}`)
      }
    }
  }

  console.log()
  console.log('='.repeat(70))

  const errorCount = results.filter(r => r.status === 'error').length
  const warningCount = results.filter(r => r.status === 'warning').length

  if (errorCount > 0) {
    console.log(`\n❌ 發現 ${errorCount} 個錯誤，${warningCount} 個警告`)
    console.log('建議：請先修復錯誤，再處理警告')
    process.exit(1)
  } else if (warningCount > 0) {
    console.log(`\n⚠️  發現 ${warningCount} 個警告`)
    console.log('建議：建議修復這些警告以確保系統穩定')
  } else {
    console.log('\n✅ 所有檢查都通過！記憶系統健康')
  }
}).catch(error => {
  console.error('❌ 診斷過程失敗:', error)
  process.exit(1)
})
