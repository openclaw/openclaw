import fs from "node:fs/promises";
import type { SandboxFsBridge, SandboxFsStat } from "./sandbox/fs-bridge.js";
import { verifyWrittenContent, verifyWrittenStat } from "./sessions/tools/write-verification.js";

export async function verifyHostFile(absolutePath: string, content: string): Promise<void> {
  let stat: { type: "file" | "directory" | "other"; size: number } | null;
  try {
    const fileStat = await fs.stat(absolutePath);
    stat = {
      type: fileStat.isFile() ? "file" : fileStat.isDirectory() ? "directory" : "other",
      size: fileStat.size,
    };
  } catch {
    stat = null;
  }

  verifyWrittenStat({ absolutePath, content, stat });
  const readback = await fs.readFile(absolutePath).catch(() => undefined);
  verifyWrittenContent({ absolutePath, content, readback });
}

export async function writeAndVerifySandboxFile(params: {
  bridge: SandboxFsBridge;
  root: string;
  absolutePath: string;
  content: string;
}): Promise<void> {
  await params.bridge.writeFile({
    filePath: params.absolutePath,
    cwd: params.root,
    data: params.content,
  });
  const stat: Pick<SandboxFsStat, "type" | "size"> | null = await params.bridge.stat({
    filePath: params.absolutePath,
    cwd: params.root,
  });
  verifyWrittenStat({ absolutePath: params.absolutePath, content: params.content, stat });
  const readback = await params.bridge
    .readFile({ filePath: params.absolutePath, cwd: params.root })
    .catch(() => undefined);
  verifyWrittenContent({
    absolutePath: params.absolutePath,
    content: params.content,
    readback,
  });
}
