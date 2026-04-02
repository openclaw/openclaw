#!/usr/bin/env node

/**
 * 记忆重构脚本 - 将现有 OpenClaw 记忆迁移到 Claude Code 风格
 *
 * 功能：
 * 1. 分析现有 memory/*.md 文件
 * 2. 按类型分类（user/feedback/project/reference）
 * 3. 添加 frontmatter（name, description, type）
 * 4. 更新 MEMORY.md 索引
 * 5. 创建日志目录结构
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join, parse } from "path";
import { fileURLToPath } from "url";

const __dirname = parse(fileURLToPath(import.meta.url)).dir;
const WORKSPACE = "/home/ang";
const MEMORY_DIR = join(WORKSPACE, "memory");
const MEMORY_INDEX = join(WORKSPACE, "MEMORY.md");

// 记忆类型关键词
const TYPE_KEYWORDS = {
  user: ["用户", "偏好", "背景", "技能", "role", "preference", "background", "skill"],
  feedback: ["反馈", "纠正", "不要", "停止", "prefer", "avoid", "stop", "don't"],
  project: ["项目", "研究", "论文", "实验", "deadline", "project", "thesis", "experiment"],
  reference: ["链接", "http", "https", "profile", "repo", "dashboard", "link"],
};

/**
 * 检测记忆类型
 */
function detectType(content, filename) {
  const text = (content + " " + filename).toLowerCase();

  const scores = {};
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    scores[type] = keywords.reduce((sum, kw) => sum + (text.includes(kw.toLowerCase()) ? 1 : 0), 0);
  }

  const maxType = Object.entries(scores).reduce((a, b) => (scores[a[0]] > scores[b[0]] ? a : b))[0];
  return scores[maxType] > 0 ? maxType : "project"; // 默认 project
}

/**
 * 提取记忆名称和描述
 */
function extractMetadata(content, filename) {
  // 尝试从标题提取
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    const firstParagraph = content.split("\n\n")[1]?.split("\n")[0]?.slice(0, 150) || "";
    return {
      name: title,
      description: firstParagraph || `关于${title.replace("记忆", "").trim()}的记录`,
    };
  }

  // 从文件名提取
  const baseName = filename.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(".md", "");
  return {
    name: baseName.replace(/[-_]/g, " "),
    description: `记录于 ${filename.replace(".md", "")}`,
  };
}

/**
 * 生成 frontmatter
 */
function generateFrontmatter(name, description, type) {
  return `---
name: ${name}
description: ${description}
type: ${type}
---

`;
}

/**
 * 重构单个记忆文件
 */
async function refactorMemoryFile(filepath) {
  const { name, base } = parse(filepath);

  // 跳过非 md 文件
  if (base.endsWith(".json") || base.endsWith(".txt")) return null;

  const content = await readFile(filepath, "utf-8");

  // 检测类型
  const type = detectType(content, base);

  // 提取元数据
  const { name: memName, description } = extractMetadata(content, base);

  // 生成新内容
  const frontmatter = generateFrontmatter(memName, description, type);
  const newContent = frontmatter + content;

  // 目标路径
  const typeDir = join(MEMORY_DIR, type);
  await mkdir(typeDir, { recursive: true });

  // 避免覆盖，添加时间戳
  const timestamp = base.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().split("T")[0];
  const newFilename = `${timestamp}-${base.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")}`;
  const newPath = join(typeDir, newFilename);

  return {
    oldPath: filepath,
    newPath,
    type,
    name: memName,
    description,
  };
}

/**
 * 更新 MEMORY.md 索引
 */
async function updateMemoryIndex(migrated) {
  let index = `# MEMORY.md - 长期记忆

_最后更新：${new Date().toISOString().split("T")[0]}_

---

`;

  // 按类型分组
  const byType = {};
  for (const item of migrated) {
    if (!byType[item.type]) byType[item.type] = [];
    byType[item.type].push(item);
  }

  // 生成索引
  const typeNames = {
    user: "👤 用户信息",
    feedback: "📋 行为指导",
    project: "🎯 项目上下文",
    reference: "🔗 外部引用",
  };

  for (const [type, items] of Object.entries(byType)) {
    index += `## ${typeNames[type] || type}\n\n`;
    for (const item of items) {
      const relPath = item.newPath.replace(WORKSPACE + "/", "");
      index += `- [${item.name}](${relPath}) — ${item.description}\n`;
    }
    index += "\n";
  }

  index += `---

**记忆系统版本：** v2.0 (Claude Code 风格)  
**重构时间：** ${new Date().toISOString()}  
**下次回顾：** ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]}
`;

  await writeFile(MEMORY_INDEX, index, "utf-8");
  console.log(`✅ 更新索引：${MEMORY_INDEX}`);
}

/**
 * 创建日志目录结构
 */
async function createLogStructure() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = now.toISOString().split("T")[0];

  const logDir = join(MEMORY_DIR, "logs", String(year), month);
  await mkdir(logDir, { recursive: true });

  const logFile = join(logDir, `${day}.md`);
  const logContent = `# ${day}

- [ ] 待记录事项

`;

  await writeFile(logFile, logContent, "utf-8");
  console.log(`✅ 创建日志：${logFile}`);
}

/**
 * 主函数
 */
async function main() {
  console.log("🔧 开始重构记忆系统...\n");

  // 读取现有记忆文件
  const files = await readdir(MEMORY_DIR, { withFileTypes: true });
  const mdFiles = files
    .filter((d) => d.isFile() && d.name.endsWith(".md") && !d.name.startsWith("2026-04-02"))
    .map((d) => join(MEMORY_DIR, d.name));

  console.log(`📁 找到 ${mdFiles.length} 个记忆文件\n`);

  // 重构每个文件
  const migrated = [];
  for (const filepath of mdFiles) {
    try {
      const result = await refactorMemoryFile(filepath);
      if (result) {
        await writeFile(result.newPath, await readFile(filepath, "utf-8"), "utf-8");
        console.log(`✅ ${result.name} → memory/${result.type}/`);
        migrated.push(result);
      }
    } catch (e) {
      console.error(`❌ 失败：${filepath} - ${e.message}`);
    }
  }

  // 更新索引
  if (migrated.length > 0) {
    console.log(`\n📝 更新 MEMORY.md 索引...`);
    await updateMemoryIndex(migrated);
  }

  // 创建日志结构
  console.log(`\n📓 创建日志目录结构...`);
  await createLogStructure();

  console.log(`\n✅ 完成！迁移了 ${migrated.length} 个记忆文件`);
  console.log(`\n下一步：`);
  console.log(`1. 检查 MEMORY.md 索引是否正确`);
  console.log(`2. 手动调整分类错误的记忆`);
  console.log(`3. 删除旧的 memory/*.md 文件（确认无误后）`);
}

main().catch(console.error);
