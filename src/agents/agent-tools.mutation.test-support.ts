import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } from "./agent-tools.read.js";

export async function seedFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

export function hostFileTools(
  root: string,
  options?: Parameters<typeof createHostWorkspaceWriteTool>[1],
) {
  const write = createHostWorkspaceWriteTool(root, options);
  const edit = createHostWorkspaceEditTool(root, options);
  return {
    write: (filePath: string, content: string) =>
      write.execute("write", { path: filePath, content }),
    edit: (filePath: string, oldText: string, newText: string) =>
      edit.execute("edit", { path: filePath, edits: [{ oldText, newText }] }),
  };
}

export function interceptOpen(
  filePath: string,
  visit: (handle: FileHandle) => void,
  accepts: (flags: Parameters<typeof fs.open>[1]) => boolean = (flags) => flags === "r+",
) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === filePath && accepts(args[1])) {
      visit(handle);
    }
    return handle;
  });
}
