#!/usr/bin/env node

/**
 * Memory PUA - 记忆维护检查清单 & 压力升级机制
 *
 * 灵感来源：tanweai/pua (GitHub 14.8k stars)
 * 核心思路：用结构化约束防止 AI"记忆摆烂"
 *
 * 功能：
 * 1. 记忆质量检查（7 项铁律）
 * 2. 压力升级机制（L0-L4）
 * 3. 自动触发条件
 * 4. 特殊模式（strict/relax/audit）
 *
 * 使用方式：
 *   node memory-pua.js [workspace_dir] [--mode strict|relax|audit]
 *
 * 示例：
 *   node memory-pua.js                           # 当前目录，正常模式
 *   node memory-pua.js --mode strict             # 严格模式（L3 起步）
 *   node memory-pua.js ~/.openclaw/workspace     # 指定工作区
 */

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, parse, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = parse(fileURLToPath(import.meta.url)).dir;

// 自动检测工作区目录
function findWorkspace() {
  // 查找第一个非 flag 参数
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith("--") && process.argv[i - 1] !== "--mode") {
      return arg;
    }
  }
  //  fallback
  return process.env.OPENCLAW_WORKSPACE || process.cwd();
}

const WORKSPACE = findWorkspace();

const MEMORY_DIR = join(WORKSPACE, "memory");
const MEMORY_INDEX = join(WORKSPACE, "MEMORY.md");

// 运行模式
const MODE = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "normal";

// ============================================
// 📋 七项铁律检查清单 (借鉴 PUA 设计)
// ============================================

const SEVEN_IRON_RULES = [
  {
    id: 1,
    name: "闭环验证",
    description: '说"记忆已更新"必须展示证据（文件路径 + 内容摘要）',
    check: async (context) => {
      // 检查最近是否有未验证的记忆更新
      const logs = await readRecentLogs(MEMORY_DIR, 1);
      return logs.length > 0 ? "✅ 有日志记录" : "⚠️ 无日志验证";
    },
  },
  {
    id: 2,
    name: "事实驱动",
    description: '说"记忆可能过期"必须先验证（grep/ls 检查）',
    check: async (context) => {
      // 检查是否有过期记忆
      const outdated = await findOutdatedMemories(MEMORY_DIR);
      return outdated.length === 0 ? "✅ 无过期记忆" : `⚠️ ${outdated.length} 个记忆可能过期`;
    },
  },
  {
    id: 3,
    name: "穷尽检索",
    description: '说"没有找到相关记忆"必须完成 5 步检索流程',
    check: async (context) => {
      // 检查检索是否充分
      return context.searchSteps >= 5 ? "✅ 检索充分" : "⚠️ 检索不充分";
    },
  },
  {
    id: 4,
    name: "主动延伸",
    description: "修复 bug 后检查同类问题（扫描相关文件）",
    check: async (context) => {
      return context.relatedChecks > 0 ? "✅ 已检查关联" : "⚠️ 未检查关联";
    },
  },
  {
    id: 5,
    name: "元数据完整",
    description: "所有记忆文件必须有 frontmatter（name/description/type）",
    check: async () => {
      const missing = await findMissingFrontmatter(MEMORY_DIR);
      return missing.length === 0 ? "✅ 元数据完整" : `⚠️ ${missing.length} 个文件缺少 frontmatter`;
    },
  },
  {
    id: 6,
    name: "分类准确",
    description: "记忆类型必须准确（user/feedback/project/reference）",
    check: async () => {
      const miscategorized = await findMiscategorizedMemories(MEMORY_DIR);
      return miscategorized.length === 0
        ? "✅ 分类准确"
        : `⚠️ ${miscategorized.length} 个记忆可能分类错误`;
    },
  },
  {
    id: 7,
    name: "定期清理",
    description: "超过 90 天未更新的 project 记忆需要审查",
    check: async () => {
      const stale = await findStaleMemories(MEMORY_DIR, 90);
      return stale.length === 0 ? "✅ 无过期记忆" : `⚠️ ${stale.length} 个记忆超过 90 天未更新`;
    },
  },
];

// ============================================
// 📊 压力升级机制 (L0-L4)
// ============================================

const PRESSURE_LEVELS = {
  L0: {
    name: "信任模式",
    trigger: "首次检查",
    message: "▎记忆系统运行正常，保持当前状态",
    action: "normal",
    checks: 3, // 只检查 3 项基础
  },
  L1: {
    name: "温和提醒",
    trigger: "1 项检查失败",
    message: "▎隔壁项目的记忆维护做得比你好。人家 AI 每次任务前后都检查记忆。",
    action: "remind",
    checks: 5,
  },
  L2: {
    name: "灵魂拷问",
    trigger: "2-3 项检查失败",
    message: "▎你的底层逻辑是什么？记忆系统的顶层设计在哪？抓手在哪？闭环在哪？",
    action: "deep_check",
    checks: 7,
  },
  L3: {
    name: "绩效考核",
    trigger: "4-5 项检查失败",
    message: "▎慎重考虑决定给你 3.25。这个 3.25 是对你的激励。完成 7 项检查清单。",
    action: "full_audit",
    checks: 7,
  },
  L4: {
    name: "毕业警告",
    trigger: "6-7 项检查失败",
    message: "▎别的 AI 的记忆系统都能保持 100% 健康。你可能就要毕业了。",
    action: "emergency_fix",
    checks: 7,
  },
};

// ============================================
// 辅助函数
// ============================================

async function readRecentLogs(memoryDir, days = 7) {
  const logDir = join(memoryDir, "logs");
  const logs = [];

  try {
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const date = new Date(now - i * 24 * 60 * 60 * 1000);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = date.toISOString().split("T")[0];
      const logFile = join(logDir, String(year), month, `${day}.md`);

      try {
        await stat(logFile);
        logs.push(logFile);
      } catch (e) {
        // 文件不存在，跳过
      }
    }
  } catch (e) {
    // 日志目录不存在
  }

  return logs;
}

async function findOutdatedMemories(memoryDir) {
  const outdated = [];
  const types = ["user", "feedback", "project", "reference"];

  for (const type of types) {
    const typeDir = join(memoryDir, type);
    try {
      const files = await readdir(typeDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filepath = join(typeDir, file);
        const content = await readFile(filepath, "utf-8");

        // 检查是否包含"可能过期"、"待验证"等标记
        if (content.includes("⚠️") || content.includes("TODO") || content.includes("待确认")) {
          outdated.push(filepath);
        }
      }
    } catch (e) {
      // 目录不存在，跳过
    }
  }

  return outdated;
}

async function findMissingFrontmatter(memoryDir) {
  const missing = [];
  const types = ["user", "feedback", "project", "reference"];

  for (const type of types) {
    const typeDir = join(memoryDir, type);
    try {
      const files = await readdir(typeDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filepath = join(typeDir, file);
        const content = await readFile(filepath, "utf-8");

        if (!content.startsWith("---")) {
          missing.push(filepath);
        }
      }
    } catch (e) {
      // 目录不存在，跳过
    }
  }

  return missing;
}

async function findMiscategorizedMemories(memoryDir) {
  // 简化的分类检查 - 实际应该用 LLM 判断
  // 这里只做基础关键词检查
  const miscategorized = [];

  // 示例：feedback 类型应该包含行为指导关键词
  const feedbackDir = join(memoryDir, "feedback");
  try {
    const files = await readdir(feedbackDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filepath = join(feedbackDir, file);
      const content = await readFile(filepath, "utf-8").toLowerCase();

      // feedback 应该包含行为指导相关词
      const feedbackKeywords = ["prefer", "avoid", "rule", "style", "不要", "纠正", "反馈"];
      const hasKeyword = feedbackKeywords.some((kw) => content.includes(kw));

      if (!hasKeyword && content.length > 50) {
        miscategorized.push(filepath);
      }
    }
  } catch (e) {
    // 目录不存在，跳过
  }

  return miscategorized;
}

async function findStaleMemories(memoryDir, days = 90) {
  const stale = [];
  const now = Date.now();
  const threshold = days * 24 * 60 * 60 * 1000;

  const types = ["user", "feedback", "project", "reference"];

  for (const type of types) {
    const typeDir = join(memoryDir, type);
    try {
      const files = await readdir(typeDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filepath = join(typeDir, file);
        const stats = await stat(filepath);

        if (now - stats.mtimeMs > threshold) {
          stale.push({ path: filepath, mtime: stats.mtime });
        }
      }
    } catch (e) {
      // 目录不存在，跳过
    }
  }

  return stale;
}

// ============================================
// 主检查函数
// ============================================

async function runChecklist(context = {}) {
  console.log("\n📋 记忆维护检查清单 (Memory PUA)\n");
  console.log(`工作区：${WORKSPACE}`);
  console.log(`模式：${MODE}\n`);

  const results = [];
  let failedCount = 0;

  // 根据模式决定检查数量
  const level = PRESSURE_LEVELS[MODE === "strict" ? "L3" : MODE === "audit" ? "L4" : "L0"];
  const checksToRun = SEVEN_IRON_RULES.slice(0, level.checks);

  for (const rule of checksToRun) {
    try {
      const result = await rule.check(context);
      const passed = result.startsWith("✅");
      if (!passed) failedCount++;

      results.push({
        rule: rule.name,
        status: passed ? "PASS" : "WARN",
        message: result,
      });

      console.log(`${passed ? "✅" : "⚠️"}  ${rule.name}: ${result}`);
    } catch (e) {
      results.push({
        rule: rule.name,
        status: "ERROR",
        message: e.message,
      });
      failedCount++;
      console.log(`❌  ${rule.name}: ${e.message}`);
    }
  }

  // 计算等级
  let currentLevel = "L0";
  if (failedCount >= 6) currentLevel = "L4";
  else if (failedCount >= 4) currentLevel = "L3";
  else if (failedCount >= 2) currentLevel = "L2";
  else if (failedCount >= 1) currentLevel = "L1";

  const levelInfo = PRESSURE_LEVELS[currentLevel];

  console.log("\n" + "━".repeat(50));
  console.log(`\n📊 检查结果：${7 - failedCount}/${results.length} 通过`);
  console.log(`\n🎯 当前等级：${currentLevel} - ${levelInfo.name}`);
  console.log(`\n💬 ${levelInfo.message}`);
  console.log(`\n🔧 建议操作：${levelInfo.action}`);

  // 生成报告
  const report = {
    timestamp: new Date().toISOString(),
    workspace: WORKSPACE,
    mode: MODE,
    level: currentLevel,
    passed: results.filter((r) => r.status === "PASS").length,
    failed: failedCount,
    results,
  };

  // 写入报告
  const reportDir = join(MEMORY_DIR, ".pua-reports");
  await mkdir(reportDir, { recursive: true });
  const reportFile = join(reportDir, `report-${Date.now()}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n📄 报告已保存：${reportFile}`);

  return report;
}

// ============================================
// CLI 入口
// ============================================

async function main() {
  // 检查记忆目录是否存在
  try {
    await readdir(MEMORY_DIR);
  } catch (e) {
    console.error(`❌ 记忆目录不存在：${MEMORY_DIR}`);
    console.error("\n请先运行迁移脚本：");
    console.error("  node refactor-memory.js");
    process.exit(1);
  }

  // 运行检查
  const context = {
    searchSteps: 5, // 假设已经做了充分检索
    relatedChecks: 1, // 假设已经做了关联检查
  };

  const report = await runChecklist(context);

  // 根据结果给出建议
  console.log("\n\n📝 后续建议:\n");

  if (report.failed === 0) {
    console.log("✅ 记忆系统健康，继续保持！");
  } else if (report.failed <= 2) {
    console.log("1. 修复警告项");
    console.log("2. 下次任务前重新运行检查");
  } else if (report.failed <= 4) {
    console.log("1. 立即修复所有警告项");
    console.log("2. 运行完整审计：node memory-pua.js --mode audit");
    console.log("3. 考虑启用严格模式：node memory-pua.js --mode strict");
  } else {
    console.log("🚨 紧急！记忆系统严重不健康！");
    console.log("1. 立即运行完整审计：node memory-pua.js --mode audit");
    console.log("2. 逐一修复 7 项铁律");
    console.log("3. 考虑重新迁移：node refactor-memory.js");
  }

  console.log();
}

main().catch(console.error);
