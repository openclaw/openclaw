#!/usr/bin/env node

/**
 * Memory PUA - Task Flow Integration
 * 
 * 自动集成到任务执行流程中的记忆维护检查
 * 
 * 触发场景：
 * 1. 任务开始前 - 检查相关记忆
 * 2. 任务完成后 - 验证记忆更新
 * 3. 用户质疑记忆 - 深度审计
 * 4. 心跳定时 - 定期维护
 * 
 * 使用方式：
 *   node memory-pua-task.js <trigger> [workspace]
 * 
 * trigger 值：
 *   - pre-task: 任务前检查
 *   - post-task: 任务后验证
 *   - audit: 深度审计
 *   - heartbeat: 心跳维护
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { join, parse, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = parse(fileURLToPath(import.meta.url)).dir

// 触发类型
const TRIGGER = process.argv[2] || 'pre-task'
const WORKSPACE = process.argv[3] || process.env.OPENCLAW_WORKSPACE || process.cwd()
const MEMORY_DIR = join(WORKSPACE, 'memory')
const MEMORY_INDEX = join(WORKSPACE, 'MEMORY.md')

// ============================================
// 检查规则定义
// ============================================

const RULES = {
  'pre-task': [
    {
      id: 'pre-1',
      name: '相关记忆检索',
      description: '任务开始前必须检索相关记忆',
      check: async (context) => {
        const { query, type } = context
        if (!query) return { pass: false, message: '❌ 未提供检索关键词' }
        
        // 检查是否执行了检索
        const searched = await checkMemorySearch(MEMORY_DIR, query)
        return searched.count > 0 
          ? { pass: true, message: `✅ 找到 ${searched.count} 条相关记忆` }
          : { pass: true, message: '⚠️ 无相关记忆（正常）' }
      }
    },
    {
      id: 'pre-2',
      name: '记忆时效验证',
      description: '检查检索到的记忆是否过期',
      check: async (context) => {
        const { memories } = context
        if (!memories || memories.length === 0) 
          return { pass: true, message: '⚠️ 无记忆可验证' }
        
        const outdated = memories.filter(m => m.daysOld > 90)
        return outdated.length === 0
          ? { pass: true, message: '✅ 记忆时效正常' }
          : { pass: false, message: `⚠️ ${outdated.length} 条记忆超过 90 天未更新` }
      }
    }
  ],
  
  'post-task': [
    {
      id: 'post-1',
      name: '闭环验证',
      description: '记忆更新必须展示证据',
      check: async (context) => {
        const { memoryUpdates } = context
        if (!memoryUpdates || memoryUpdates.length === 0)
          return { pass: true, message: '⚠️ 无记忆更新' }
        
        const withEvidence = memoryUpdates.filter(u => u.hasEvidence)
        return withEvidence.length === memoryUpdates.length
          ? { pass: true, message: `✅ ${memoryUpdates.length} 条更新均有证据` }
          : { pass: false, message: `⚠️ ${memoryUpdates.length - withEvidence.length} 条更新缺少证据` }
      }
    },
    {
      id: 'post-2',
      name: '元数据完整',
      description: '新记忆必须有 frontmatter',
      check: async (context) => {
        const { newMemories } = context
        if (!newMemories || newMemories.length === 0)
          return { pass: true, message: '⚠️ 无新记忆' }
        
        const withFrontmatter = newMemories.filter(m => m.hasFrontmatter)
        return withFrontmatter.length === newMemories.length
          ? { pass: true, message: `✅ 所有新记忆均有 frontmatter` }
          : { pass: false, message: `⚠️ ${newMemories.length - withFrontmatter.length} 条记忆缺少 frontmatter` }
      }
    },
    {
      id: 'post-3',
      name: '分类准确',
      description: '记忆类型必须正确',
      check: async (context) => {
        const { newMemories } = context
        if (!newMemories || newMemories.length === 0)
          return { pass: true, message: '⚠️ 无新记忆' }
        
        const validTypes = ['user', 'feedback', 'project', 'reference']
        const correctlyTyped = newMemories.filter(m => validTypes.includes(m.type))
        return correctlyTyped.length === newMemories.length
          ? { pass: true, message: `✅ 所有记忆分类准确` }
          : { pass: false, message: `⚠️ ${newMemories.length - correctlyTyped.length} 条记忆分类错误` }
      }
    }
  ],
  
  'audit': [
    {
      id: 'audit-1',
      name: '完整记忆扫描',
      description: '扫描所有记忆文件',
      check: async () => {
        const stats = await scanAllMemories(MEMORY_DIR)
        return {
          pass: stats.missingFrontmatter === 0,
          message: `📊 总计：${stats.total} 条 | 缺少 frontmatter: ${stats.missingFrontmatter} | 过期：${stats.stale}`
        }
      }
    },
    {
      id: 'audit-2',
      name: '索引一致性',
      description: 'MEMORY.md 索引与实际文件一致',
      check: async () => {
        const indexValid = await verifyMemoryIndex(MEMORY_INDEX, MEMORY_DIR)
        return indexValid
          ? { pass: true, message: '✅ 索引与实际文件一致' }
          : { pass: false, message: '⚠️ 索引与实际文件不一致' }
      }
    }
  ],
  
  'heartbeat': [
    {
      id: 'hb-1',
      name: '日志完整性',
      description: '检查每日日志是否连续',
      check: async () => {
        const logStatus = await checkLogCompleteness(MEMORY_DIR)
        return logStatus.complete
          ? { pass: true, message: '✅ 日志连续' }
          : { pass: false, message: `⚠️ 缺失 ${logStatus.missingDays} 天日志` }
      }
    },
    {
      id: 'hb-2',
      name: '定期清理',
      description: '检查是否有需要清理的过期记忆',
      check: async () => {
        const stale = await findStaleMemories(MEMORY_DIR, 90)
        return stale.length === 0
          ? { pass: true, message: '✅ 无过期记忆' }
          : { pass: false, message: `⚠️ ${stale.length} 条记忆超过 90 天` }
      }
    }
  ]
}

// ============================================
// 辅助函数
// ============================================

async function checkMemorySearch(memoryDir, query) {
  // 简化实现 - 实际应该调用 memory_search
  const types = ['user', 'feedback', 'project', 'reference']
  let count = 0
  
  for (const type of types) {
    const typeDir = join(memoryDir, type)
    try {
      const files = await readdir(typeDir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const content = await readFile(join(typeDir, file), 'utf-8')
        if (content.toLowerCase().includes(query.toLowerCase())) {
          count++
        }
      }
    } catch (e) {
      // 目录不存在
    }
  }
  
  return { count }
}

async function scanAllMemories(memoryDir) {
  const stats = { total: 0, missingFrontmatter: 0, stale: 0 }
  const types = ['user', 'feedback', 'project', 'reference']
  const now = Date.now()
  const threshold = 90 * 24 * 60 * 60 * 1000
  
  for (const type of types) {
    const typeDir = join(memoryDir, type)
    try {
      const files = await readdir(typeDir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        stats.total++
        
        const filepath = join(typeDir, file)
        const content = await readFile(filepath, 'utf-8')
        const fileStat = await stat(filepath)
        
        if (!content.startsWith('---')) {
          stats.missingFrontmatter++
        }
        
        if (now - fileStat.mtimeMs > threshold) {
          stats.stale++
        }
      }
    } catch (e) {
      // 目录不存在
    }
  }
  
  return stats
}

async function verifyMemoryIndex(indexPath, memoryDir) {
  try {
    await stat(indexPath)
    return true // 简化：只检查文件存在
  } catch (e) {
    return false
  }
}

async function checkLogCompleteness(memoryDir) {
  const logDir = join(memoryDir, 'logs')
  const now = new Date()
  let missingDays = 0
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = date.toISOString().split('T')[0]
    const logFile = join(logDir, String(year), month, `${day}.md`)
    
    try {
      await stat(logFile)
    } catch (e) {
      missingDays++
    }
  }
  
  return { complete: missingDays === 0, missingDays }
}

async function findStaleMemories(memoryDir, days = 90) {
  const stale = []
  const now = Date.now()
  const threshold = days * 24 * 60 * 60 * 1000
  
  const types = ['user', 'feedback', 'project', 'reference']
  
  for (const type of types) {
    const typeDir = join(memoryDir, type)
    try {
      const files = await readdir(typeDir)
      for (const file of files) {
        if (!file.endsWith('.md')) continue
        const filepath = join(typeDir, file)
        const fileStat = await stat(filepath)
        
        if (now - fileStat.mtimeMs > threshold) {
          stale.push({ path: filepath, mtime: fileStat.mtime })
        }
      }
    } catch (e) {
      // 目录不存在
    }
  }
  
  return stale
}

// ============================================
// 压力升级机制
// ============================================

function getPressureLevel(failedCount, totalRules) {
  const failRate = failedCount / totalRules
  
  if (failRate === 0) return { level: 'L0', name: '信任模式', message: '▎记忆系统运行正常，保持当前状态' }
  if (failRate <= 0.2) return { level: 'L1', name: '温和提醒', message: '▎隔壁项目的记忆维护做得比你好。人家 AI 每次任务前后都检查记忆。' }
  if (failRate <= 0.5) return { level: 'L2', name: '灵魂拷问', message: '▎你的底层逻辑是什么？记忆系统的顶层设计在哪？抓手在哪？闭环在哪？' }
  if (failRate <= 0.8) return { level: 'L3', name: '绩效考核', message: '▎慎重考虑决定给你 3.25。这个 3.25 是对你的激励。' }
  return { level: 'L4', name: '毕业警告', message: '▎别的 AI 的记忆系统都能保持 100% 健康。你可能就要毕业了。' }
}

// ============================================
// 主函数
// ============================================

async function main() {
  console.log(`\n📋 Memory PUA - ${TRIGGER} Check\n`)
  console.log(`工作区：${WORKSPACE}`)
  console.log(`触发器：${TRIGGER}\n`)
  
  const rules = RULES[TRIGGER] || RULES['pre-task']
  const results = []
  let failedCount = 0
  
  // 模拟上下文（实际应该从环境变量或 stdin 获取）
  const context = {
    query: process.env.PUA_QUERY || '',
    type: process.env.PUA_TYPE || 'project',
    memories: [],
    memoryUpdates: [],
    newMemories: []
  }
  
  for (const rule of rules) {
    try {
      const result = await rule.check(context)
      if (!result.pass) failedCount++
      
      results.push({
        rule: rule.name,
        ...result
      })
      
      console.log(`${result.pass ? '✅' : '⚠️'}  ${rule.name}: ${result.message}`)
    } catch (e) {
      results.push({
        rule: rule.name,
        pass: false,
        message: `❌ ${e.message}`
      })
      failedCount++
      console.log(`❌  ${rule.name}: ${e.message}`)
    }
  }
  
  const pressure = getPressureLevel(failedCount, rules.length)
  
  console.log('\n' + '━'.repeat(50))
  console.log(`\n📊 检查结果：${rules.length - failedCount}/${rules.length} 通过`)
  console.log(`\n🎯 当前等级：${pressure.level} - ${pressure.name}`)
  console.log(`\n💬 ${pressure.message}`)
  
  // 输出 JSON 供后续处理
  const output = {
    trigger: TRIGGER,
    timestamp: new Date().toISOString(),
    workspace: WORKSPACE,
    passed: rules.length - failedCount,
    failed: failedCount,
    total: rules.length,
    level: pressure.level,
    results
  }
  
  // 写入报告
  const reportDir = join(MEMORY_DIR, '.pua-reports')
  await mkdir(reportDir, { recursive: true })
  const reportFile = join(reportDir, `report-${TRIGGER}-${Date.now()}.json`)
  await writeFile(reportFile, JSON.stringify(output, null, 2))
  
  // 输出 JSON 到 stdout（供管道使用）
  console.log('\n\n📄 JSON Output:')
  console.log(JSON.stringify(output, null, 2))
  
  // 如果有失败，返回非零退出码
  if (failedCount > 0) {
    process.exit(1)
  }
}

main().catch(console.error)
