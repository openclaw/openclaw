import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";

const git = simpleGit();

/**
 * 進度管理：讀取已完成清單
 */
export async function loadProgress(progressFile: string): Promise<string[]> {
  try {
    const data = await fs.readFile(progressFile, "utf-8");
    return (JSON.parse(data) as { completed: string[] }).completed || [];
  } catch {
    return [];
  }
}

/**
 * 進度管理：儲存已完成檔案
 */
export async function saveProgress(progressFile: string, completedFile: string) {
  let completed: string[] = [];
  try {
    const data = await fs.readFile(progressFile, "utf-8");
    completed = (JSON.parse(data) as { completed: string[] }).completed || [];
  } catch {}

  if (!completed.includes(completedFile)) {
    completed.push(completedFile);
    await fs.writeFile(progressFile, JSON.stringify({ completed }, null, 2));
  }
}

/**
 * 掃描待翻譯檔案 (支援 Git Diff 與 目錄掃描)
 */
export async function getPendingFiles(options: {
  docsDir: string;
  isForce: boolean;
  completedFiles: string[];
}): Promise<string[]> {
  const { docsDir, isForce, completedFiles } = options;
  const list: string[] = [];

  // Git Diff 邏輯
  if (!isForce) {
    try {
      const remotes = await git.getRemotes();
      const hasUpstream = remotes.some((r) => r.name === "upstream");
      const compareTarget = hasUpstream ? "upstream/main...HEAD" : "origin/main...HEAD";
      const diffSummary = await git.diffSummary([compareTarget, "--", docsDir]);
      for (const file of diffSummary.files) {
        if (file.file.endsWith(".md") && !file.file.includes("zh-TW")) {
          if (!completedFiles.includes(file.file)) list.push(file.file);
        }
      }
    } catch {}
  }

  // 目錄掃描邏輯 (如果 Diff 為空或 force)
  if (list.length === 0 || isForce) {
    async function scan(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(process.cwd(), fullPath);
        if (entry.isDirectory()) {
          if (!["zh-TW", "zh-CN", "ja-JP", ".i18n", "assets", "images"].includes(entry.name))
            await scan(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (isForce) {
            if (!completedFiles.includes(relPath)) list.push(relPath);
          } else {
            const target = relPath.replace(/^docs\//, "docs/zh-TW/");
            try {
              await fs.access(target);
            } catch {
              list.push(relPath);
            }
          }
        }
      }
    }
    await scan(docsDir);
  }

  return Array.from(new Set(list));
}
