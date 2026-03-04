/**
 * Strategy directory packer: ZIP creation for upload to Backtest Agent.
 *
 * Uses `jszip` (hoisted from root) to create in-memory ZIP archives.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import JSZip from "jszip";

/**
 * Recursively collect all file paths under a directory.
 */
async function collectFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, base)));
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
  return files;
}

/**
 * Pack a local strategy directory into a ZIP Buffer (in-memory).
 *
 * @param dirPath - Absolute or relative path to the strategy directory.
 * @returns ZIP buffer ready for upload.
 */
export async function packStrategy(dirPath: string): Promise<Buffer> {
  const s = await stat(dirPath);
  if (!s.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }

  const folderName = basename(dirPath);
  const files = await collectFiles(dirPath, dirPath);

  const zip = new JSZip();
  const folder = zip.folder(folderName)!;

  for (const relPath of files) {
    const content = await readFile(join(dirPath, relPath));
    folder.file(relPath, content);
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buf;
}
