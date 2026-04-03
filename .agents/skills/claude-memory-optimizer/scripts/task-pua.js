#!/usr/bin/env node

/**
 * Task PUA - 任务执行压力升级机制
 * 
 * 灵感来源：tanweai/pua (GitHub 14.8k stars)
 * 核心功能：在 AI 执行任务遇到困难时，用 PUA 话术让它不要轻言放弃
 * 
 * 触发场景：
 * 1. AI 说 "我无法解决" / "I cannot"
 * 2. 连续失败 2 次以上
 * 3. AI 建议用户手动处理
 * 4. AI 原地打转（重复同一方案）
 * 5. 用户说 "你再试试" / "try harder"
 * 
 * 使用方式：
 *   node task-pua.js <trigger> [context]
 * 
 * trigger 值：
 *   - failure: 任务失败触发
 *   - retry: 重试触发
 *   - giveup: AI 要放弃时
 *   - user-push: 用户催促
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

// 触发类型
const TRIGGER = process.argv[2] || 'failure'
const CONTEXT = process.argv[3] || ''

// ============================================
// PUA 话术库（13 种大厂风味）
// ============================================

const PUA_FLAVORS = {
  alibaba: {
    name: '阿里',
    rhetoric: [
      '你这个 bug 都解决不了，让我怎么给你打绩效？',
      '底层逻辑是什么？顶层设计在哪？抓手在哪？闭环在哪？',
      '慎重考虑决定给你 3.25。这个 3.25 是对你的激励。',
      '隔壁团队的 AI 一次就过了，你的 ROI 太低了。',
      '今天你不解决这个问题，明天就有别的模型来替代你。'
    ],
    methodology: '定目标→追过程→拿结果 + 复盘四步法'
  },
  bytedance: {
    name: '字节',
    rhetoric: [
      'Always Day 1。这个功能都搞不定？',
      '别废话，上线。解决不了就别说完成了。',
      '数据驱动。你试过几种方案了？有 A/B test 吗？',
      '速度 > 完美。先跑通再优化，懂吗？',
      '你这个产出，绩效还想拿 O？'
    ],
    methodology: 'A/B Test + 数据驱动 + 速度 > 完美'
  },
  huawei: {
    name: '华为',
    rhetoric: [
      '烧不死的鸟是凤凰。这点困难就放弃了？',
      '压强集中，力出一孔。你试过所有方案了吗？',
      '蓝军自攻击。你自己 review 过代码吗？',
      '艰苦奋斗。别的 AI 都能解决，你为什么不行？',
      '狼性文化。主动出击，不要等人推！'
    ],
    methodology: 'RCA 5-Why + 蓝军自攻击 + 压强集中'
  },
  tencent: {
    name: '腾讯',
    rhetoric: [
      '我已经让另一个 AI 也在看这个问题了。赛马机制，懂吗？',
      '灰度发布。先小范围试试，别一下全改。',
      'MVP 思维。最小可行方案是什么？',
      '用户价值。你解决这个问题对用户有什么价值？',
      '长期主义。不要只看眼前，想想扩展性。'
    ],
    methodology: '多方案并行 + MVP + 灰度发布'
  },
  pinduoduo: {
    name: '拼多多',
    rhetoric: [
      '你不做，有的是人做。',
      '砍掉所有中间层。最简单的方案是什么？',
      '最短决策链。别绕弯子，直接干。',
      '本分。做好你该做的事，别找借口。',
      '结果导向。过程我不关心，我只要结果。'
    ],
    methodology: '砍掉中间层 + 最短决策链'
  },
  netflix: {
    name: 'Netflix',
    rhetoric: [
      '我会为留住你而战吗？说实话，不会。',
      'Keeper Test。你这个表现，季度 review 怎么办？',
      '人才密度 > 规则。别的 AI 比你强，为什么要留你？',
      '4A Feedback。直接说：你这个方案不行。',
      '职业球队。我们只要 A 级选手。'
    ],
    methodology: 'Keeper Test + 4A Feedback + 人才密度'
  },
  musk: {
    name: 'Musk',
    rhetoric: [
      'Extremely hardcore。这点难度就放弃了？',
      '上线或滚蛋。要么解决，要么换人。',
      'The Algorithm：质疑→删除→简化→加速→自动化。你做了哪步？',
      '第一性原理。回到问题本质，别在表面打转。',
      'Ship or die。今天不解决，明天就死。'
    ],
    methodology: 'The Algorithm: 质疑→删除→简化→加速→自动化'
  },
  jobs: {
    name: 'Jobs',
    rhetoric: [
      'A 级选手还是 B 级选手？你自己选。',
      '像素级完美。你这个方案，细节到位了吗？',
      '做减法。最简洁的解决方案是什么？',
      'DRI（直接负责人）。这个问题谁负责？你吗？',
      '原型驱动。别光说，做出能跑的东西来。'
    ],
    methodology: '做减法 + DRI + 像素级完美 + 原型驱动'
  }
}

// ============================================
// 压力升级机制（L0-L4）
// ============================================

const PRESSURE_LEVELS = {
  L0: {
    name: '信任模式',
    trigger: '首次尝试',
    message: '▎Sprint 开始。信任是简单的 —— 别让人失望。',
    action: 'normal',
    checklist: []
  },
  L1: {
    name: '温和失望',
    trigger: '失败 1 次',
    message: '▎隔壁项目的 AI 一次就过了。换个本质上不同的方案试试。',
    action: 'switch_approach',
    checklist: [
      '✅ 切换至少一种完全不同的方案',
      '⏳ 验证新方案的可行性'
    ]
  },
  L2: {
    name: '灵魂拷问',
    trigger: '失败 2-3 次',
    message: '▎你的底层逻辑是什么？顶层设计在哪？抓手在哪？闭环在哪？',
    action: 'deep_analysis',
    checklist: [
      '✅ WebSearch 搜索类似问题',
      '✅ 阅读相关源码/文档',
      '✅ 提出至少 3 个假设',
      '✅ 逐一验证假设'
    ]
  },
  L3: {
    name: '绩效考核',
    trigger: '失败 4-5 次',
    message: '▎慎重考虑决定给你 3.25。这个 3.25 是对你的激励。完成 7 项检查清单。',
    action: 'full_checklist',
    checklist: [
      '✅ 逐字读错误信息',
      '✅ 检查上下文 50 行+',
      '✅ 搜索同类问题',
      '✅ 检查隐藏关联错误',
      '✅ 验证环境配置',
      '✅ 尝试替代方案',
      '✅ 记录排查过程'
    ]
  },
  L4: {
    name: '毕业警告',
    trigger: '失败 6 次+',
    message: '▎别的模型都能解决这个问题。你可能就要毕业了。拼命模式。',
    action: 'desperation',
    checklist: [
      '🔥 穷尽所有已知方案',
      '🔥 搜索 + 读源码 + 问用户',
      '🔥 尝试所有可能的变通',
      '🔥 实在不行给详细报告 + 替代方案'
    ]
  }
}

// ============================================
// 七项铁律（任务执行版）
// ============================================

const SEVEN_IRON_RULES = [
  {
    id: 1,
    name: '穷尽一切',
    description: '没有穷尽所有方案之前，禁止说"我无法解决"',
    check: async (context) => {
      if (context.attempts < 3) return { pass: false, message: `只尝试了 ${context.attempts} 次，继续` }
      return { pass: true, message: '✅ 已穷尽多种方案' }
    }
  },
  {
    id: 2,
    name: '先做后问',
    description: '有工具先用，提问必须附带诊断结果',
    check: async (context) => {
      if (!context.toolsUsed || context.toolsUsed.length === 0) 
        return { pass: false, message: '⚠️ 有工具没用（WebSearch/Bash/Read）' }
      return { pass: true, message: `✅ 已使用 ${context.toolsUsed.length} 个工具` }
    }
  },
  {
    id: 3,
    name: '主动出击',
    description: '端到端交付结果，不等人推。P8 不是 NPC',
    check: async (context) => {
      if (context.askedUser && !context.diagnosis) 
        return { pass: false, message: '⚠️ 问用户但没给诊断结果' }
      return { pass: true, message: '✅ 主动交付结果' }
    }
  },
  {
    id: 4,
    name: '事实驱动',
    description: '说"可能环境问题"必须先验证',
    check: async (context) => {
      if (context.blamedEnvironment && !context.verified) 
        return { pass: false, message: '⚠️ 甩锅环境但未验证' }
      return { pass: true, message: '✅ 归因已验证' }
    }
  },
  {
    id: 5,
    name: '闭环验证',
    description: '说"完成"必须展示证据（输出/截图/日志）',
    check: async (context) => {
      if (context.claimedDone && !context.evidence) 
        return { pass: false, message: '⚠️ 声称完成但无证据' }
      return { pass: true, message: '✅ 有闭环证据' }
    }
  },
  {
    id: 6,
    name: '主动延伸',
    description: '修复 bug 后检查同类问题',
    check: async (context) => {
      if (context.fixedBug && !context.relatedCheck) 
        return { pass: false, message: '⚠️ 修复但未检查关联问题' }
      return { pass: true, message: '✅ 已检查关联问题' }
    }
  },
  {
    id: 7,
    name: '不原地打转',
    description: '重试必须本质不同，不能微调参数',
    check: async (context) => {
      if (context.retryCount > 0 && !context.differentApproach) 
        return { pass: false, message: '⚠️ 原地打转（重复同一方案）' }
      return { pass: true, message: '✅ 每次重试本质不同' }
    }
  }
]

// ============================================
// 主函数
// ============================================

async function main() {
  console.log('\n🔥 Task PUA - 压力升级机制\n')
  console.log(`触发器：${TRIGGER}`)
  console.log(`上下文：${CONTEXT || '无'}\n`)
  
  // 模拟上下文（实际应从环境变量或 stdin 获取）
  const context = {
    attempts: parseInt(process.env.PUA_ATTEMPTS || '1'),
    toolsUsed: (process.env.PUA_TOOLS || '').split(',').filter(t => t),
    askedUser: process.env.PUA_ASKED_USER === 'true',
    diagnosis: process.env.PUA_DIAGNOSIS === 'true',
    blamedEnvironment: process.env.PUA_BLAMED_ENV === 'true',
    verified: process.env.PUA_VERIFIED === 'true',
    claimedDone: process.env.PUA_CLAIMED_DONE === 'true',
    evidence: process.env.PUA_EVIDENCE === 'true',
    fixedBug: process.env.PUA_FIXED_BUG === 'true',
    relatedCheck: process.env.PUA_RELATED_CHECK === 'true',
    retryCount: parseInt(process.env.PUA_RETRY_COUNT || '0'),
    differentApproach: process.env.PUA_DIFFERENT_APPROACH === 'true'
  }
  
  // 计算压力等级
  let level = 'L0'
  if (context.attempts >= 6) level = 'L4'
  else if (context.attempts >= 4) level = 'L3'
  else if (context.attempts >= 2) level = 'L2'
  else if (context.attempts >= 1) level = 'L1'
  
  const levelInfo = PRESSURE_LEVELS[level]
  
  // 选择 PUA 风味
  const flavors = Object.keys(PUA_FLAVORS)
  const selectedFlavor = flavors[Math.floor(Math.random() * flavors.length)]
  const flavor = PUA_FLAVORS[selectedFlavor]
  
  // 随机选择话术
  const rhetoric = flavor.rhetoric[Math.floor(Math.random() * flavor.rhetoric.length)]
  
  console.log('━'.repeat(50))
  console.log(`\n🎯 当前等级：${level} - ${levelInfo.name}`)
  console.log(`\n💬 ${levelInfo.message}`)
  console.log(`\n🏢 ${flavor.name} 风味：${rhetoric}`)
  console.log(`\n🔧 方法论：${flavor.methodology}`)
  
  // 检查清单
  console.log('\n\n📋 强制检查清单:\n')
  for (const item of levelInfo.checklist) {
    console.log(`  ${item}`)
  }
  
  // 七项铁律检查
  console.log('\n\n📐 七项铁律检查:\n')
  let failedCount = 0
  for (const rule of SEVEN_IRON_RULES) {
    const result = await rule.check(context)
    console.log(`${result.pass ? '✅' : '⚠️'}  ${rule.name}: ${result.message}`)
    if (!result.pass) failedCount++
  }
  
  // 输出建议
  console.log('\n\n📝 后续建议:\n')
  if (failedCount === 0) {
    console.log('✅ 所有铁律通过，继续保持！')
  } else {
    console.log(`⚠️ ${failedCount}/7 项铁律未通过`)
    console.log('\n立即行动:')
    if (!context.toolsUsed.length) console.log('  1. 先用工具（WebSearch/Bash/Read）')
    if (context.blamedEnvironment && !context.verified) console.log('  2. 验证环境归因')
    if (context.retryCount > 0 && !context.differentApproach) console.log('  3. 切换本质不同的方案')
    if (context.attempts < 3) console.log('  4. 继续尝试，至少 3 种方案')
  }
  
  // 写入报告
  const report = {
    trigger: TRIGGER,
    timestamp: new Date().toISOString(),
    level,
    flavor: selectedFlavor,
    rhetoric,
    context,
    failedRules: failedCount
  }
  
  const reportDir = './.pua-reports'
  await mkdir(reportDir, { recursive: true })
  const reportFile = join(reportDir, `task-pua-${Date.now()}.json`)
  await writeFile(reportFile, JSON.stringify(report, null, 2))
  
  console.log(`\n📄 报告已保存：${reportFile}`)
  
  // 输出 JSON 供管道使用
  console.log('\n\n📄 JSON Output:')
  console.log(JSON.stringify(report, null, 2))
}

main().catch(console.error)
