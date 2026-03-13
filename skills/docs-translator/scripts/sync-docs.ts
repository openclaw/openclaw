import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import matter from "gray-matter";
import { OpenAI } from "openai";
import { simpleGit } from "simple-git";

const execAsync = promisify(exec);
const git = simpleGit();

const __filename = fileURLToPath(import.meta.url);
const DICT_PATH = path.join(process.cwd(), "scripts", "zh-TW-linter.json");
const DOCS_DIR = path.join(process.cwd(), "docs");
const PROGRESS_FILE = path.join(process.cwd(), ".docs-sync-progress.json");

interface Rule {
  pattern: string;
  replacement: string;
}

// ==========================================
// 模組 1: 原子化段落處理 與 進度管理
// ==========================================

async function loadProgress(): Promise<string[]> {
  try {
    const data = await fs.readFile(PROGRESS_FILE, "utf-8");
    return (JSON.parse(data) as { completed: string[] }).completed || [];
  } catch {
    return [];
  }
}

async function saveProgress(completedFile: string) {
  const completed = await loadProgress();
  if (!completed.includes(completedFile)) {
    completed.push(completedFile);
    await fs.writeFile(PROGRESS_FILE, JSON.stringify({ completed }, null, 2));
  }
}

export function maskParagraphCodeBlocks(paragraph: string): {
  masked: string;
  blocks: Map<string, string>;
} {
  const blocks = new Map<string, string>();
  const blockRegex = /```[\s\S]*?```/g;
  let blockIndex = 0;
  let masked = paragraph.replace(blockRegex, (match) => {
    const placeholder = `[[BLOCK_${blockIndex}]]`;
    blocks.set(placeholder, match);
    blockIndex++;
    return placeholder;
  });

  const inlineRegex = /`([^`\n]+)`/g;
  let inlineIndex = 0;
  masked = masked.replace(inlineRegex, (match) => {
    const placeholder = `[[INLINE_${inlineIndex}]]`;
    blocks.set(placeholder, match);
    inlineIndex++;
    return placeholder;
  });

  return { masked, blocks };
}

export function unmaskParagraphCodeBlocks(masked: string, blocks: Map<string, string>): string {
  let cleaned = masked.replace(/`/g, "");
  let restored = cleaned;
  const sortedPlaceholders = Array.from(blocks.keys()).sort((a, b) => b.length - a.length);
  for (const placeholder of sortedPlaceholders) {
    const original = blocks.get(placeholder)!;
    restored = restored.split(placeholder).join(original);
  }
  return restored;
}

export function splitIntoParagraphs(content: string): string[] {
  const parsed = matter(content);
  return parsed.content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export async function applyLocalization(content: string): Promise<string> {
  const dictRaw = await fs.readFile(DICT_PATH, "utf-8");
  const dict = JSON.parse(dictRaw) as { rules: Rule[] };
  let processed = content;
  for (const rule of dict.rules) {
    const regex = new RegExp(rule.pattern, "g");
    processed = processed.replace(regex, rule.replacement);
  }
  return processed;
}

export function extractCodeBlocks(content: string): string[] {
  const codeBlocks: string[] = [];
  const blockRegex = /```[\s\S]*?```/g;
  const inlineRegex = /`([^`\n]+)`/g;
  const blocks = content.match(blockRegex) || [];
  codeBlocks.push(...blocks.map((b) => b.trim()));
  const withoutBlocks = content.replace(blockRegex, "");
  let match;
  while ((match = inlineRegex.exec(withoutBlocks)) !== null) {
    codeBlocks.push(match[0].trim());
  }
  return codeBlocks;
}

// ==========================================
// 模組 3: AI 翻譯引擎
// ==========================================

async function translateParagraph(maskedParagraph: string, retryCount = 0): Promise<string> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const openai = new OpenAI({ apiKey });
    const systemPrompt = `你是一個技術文件翻譯機器人。將段落翻譯為台灣繁體中文（zh-TW）。
1. 嚴格保留 [[BLOCK_N]] 和 [[INLINE_N]] 標籤。
2. 絕對不可添加新的反引號 (\`)。
3. 使用台灣繁體慣用語，保留 API, SDK, CLI, token。`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: maskedParagraph },
      ],
      temperature: 0,
    });

    return response.choices[0].message.content || "";
  } catch (err: unknown) {
    if (retryCount < 2) return translateParagraph(maskedParagraph, retryCount + 1);
    throw err;
  }
}

async function runMarkdownLint(filePath: string): Promise<boolean> {
  try {
    await execAsync(`pnpm dlx markdownlint-cli2 "${filePath}"`);
    return true;
  } catch {
    return false;
  }
}

// ==========================================
// 模組 4: 主管線
// ==========================================

async function main() {
  const args = process.argv.slice(2);
  const isForce = args.includes("--force");
  const targetFile = args.find((a) => a.startsWith("--file="))?.split("=")[1];

  console.log(`🚀 OpenClaw Docs 自動翻譯啟動 (Atomic Mode 5.1 - Resumable)\n`);

  const completedFiles = await loadProgress();
  if (completedFiles.length > 0) {
    console.log(`[續傳] 發現前次執行進度，將跳過 ${completedFiles.length} 個已完成檔案。\n`);
  }

  const pendingFiles = targetFile
    ? [targetFile]
    : await (async () => {
        const list: string[] = [];

        if (!isForce) {
          try {
            const remotes = await git.getRemotes();
            const hasUpstream = remotes.some((r) => r.name === "upstream");
            const compareTarget = hasUpstream ? "upstream/main...HEAD" : "origin/main...HEAD";

            console.log(`[Git] 正在與 ${compareTarget} 進行差異比對...`);
            const diffSummary = await git.diffSummary([compareTarget, "--", "docs/"]);
            for (const file of diffSummary.files) {
              if (file.file.endsWith(".md") && !file.file.includes("zh-TW")) {
                if (!completedFiles.includes(file.file)) list.push(file.file);
              }
            }
          } catch {
            console.log("無法進行 Git 比對，將降級為掃描全目錄缺失檔案。");
          }
        }

        if (list.length === 0 || isForce) {
          async function scanDir(dir: string) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              const relPath = path.relative(process.cwd(), fullPath);
              if (entry.isDirectory()) {
                if (!["zh-TW", "zh-CN", "ja-JP", ".i18n", "assets", "images"].includes(entry.name))
                  await scanDir(fullPath);
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                if (isForce) {
                  if (!completedFiles.includes(relPath)) list.push(relPath);
                } else {
                  try {
                    await fs.access(
                      path.join(process.cwd(), relPath.replace(/^docs\//, "docs/zh-TW/")),
                    );
                  } catch {
                    list.push(relPath);
                  }
                }
              }
            }
          }
          await scanDir(DOCS_DIR);
        }
        return Array.from(new Set(list));
      })();

  console.log(`[發現] 共有 ${pendingFiles.length} 個檔案需要翻譯。\n`);

  for (const file of pendingFiles) {
    console.log(`========================================`);
    console.log(`[處理中] ${file}`);
    const sourcePath = path.join(process.cwd(), file);
    const targetRelPath = file.replace(/^docs\//, "docs/zh-TW/");
    const targetPath = path.join(process.cwd(), targetRelPath);

    try {
      const sourceRaw = await fs.readFile(sourcePath, "utf-8");
      const parsedSource = matter(sourceRaw);
      const paragraphs = splitIntoParagraphs(sourceRaw);
      const translatedParagraphs: string[] = [];

      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        process.stdout.write(`  -> 段落 ${i + 1}/${paragraphs.length}... `);

        const { masked, blocks } = maskParagraphCodeBlocks(p);
        let success = false;
        let finalP = "";

        for (let attempt = 0; attempt < 5; attempt++) {
          let translatedMasked = await translateParagraph(masked);
          finalP = unmaskParagraphCodeBlocks(translatedMasked, blocks);

          const normalize = (str: string) =>
            str
              .replace(/\s+/g, "")
              .replace(/["“”]/g, "'")
              .replace(/['‘’]/g, "'")
              .replace(/[…\.]+/g, "...");
          const sBlocks = extractCodeBlocks(p).map(normalize);
          const tBlocks = extractCodeBlocks(finalP).map(normalize);

          if (sBlocks.length === tBlocks.length) {
            const sSorted = [...sBlocks].sort();
            const tSorted = [...tBlocks].sort();
            let match = true;
            for (let j = 0; j < sSorted.length; j++) {
              if (!sSorted[j].includes("mermaid") && sSorted[j] !== tSorted[j]) {
                match = false;
                break;
              }
            }
            if (match) {
              success = true;
              break;
            }
          }
          if (attempt < 4) process.stdout.write(`(R${attempt + 1}) `);
        }

        if (!success) {
          console.error(`\n❌ [驗證失敗] 段落 ${i + 1} 連續失敗。`);
          process.exit(1);
        }

        translatedParagraphs.push(finalP);
        process.stdout.write(`✅\n`);
      }

      let finalBody = translatedParagraphs.join("\n\n");
      finalBody = await applyLocalization(finalBody);
      const finalTranslated = matter.stringify(finalBody, parsedSource.data);

      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, finalTranslated, "utf-8");

      // 執行 Lint
      if (!(await runMarkdownLint(targetPath))) {
        console.error(`\n❌ [Linter] ${file} 語法檢查失敗。`);
        process.exit(1);
      }

      await saveProgress(file);
      console.log(`✅ [完成] ${file} 翻譯成功！`);
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`❌ [異常] ${file}: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(`\n🎉 任務全數完成！清理進度檔...`);
  await fs.rm(PROGRESS_FILE, { force: true }).catch(() => {});
}

if (process.argv[1] === __filename) main().catch(console.error);
