import fs from "node:fs/promises";
import path from "node:path";
import { registerCreatedPdfInShoarchive } from "../src/shoarchive/pdf-shoarchive.js";

async function collectPdfs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const pdfs: string[] = [];
  for (const entry of entries) {
    if (entry.name === "registry") {
      continue;
    }
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      pdfs.push(...(await collectPdfs(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      pdfs.push(absolutePath);
    }
  }
  return pdfs;
}

async function main() {
  const workspaceRoot =
    process.argv[2] ?? path.join(process.env.HOME ?? "", ".openclaw", "workspace");
  const creationsRoot = path.join(workspaceRoot, "creations");
  const pdfs = await collectPdfs(creationsRoot);
  let updated = 0;
  for (const pdfPath of pdfs) {
    await registerCreatedPdfInShoarchive({
      sourcePath: pdfPath,
      workspaceRoot,
    });
    updated += 1;
  }
  process.stdout.write(`${JSON.stringify({ workspaceRoot, updated, pdfs: pdfs.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
