import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } from "./agent-tools.read.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

export function asSource<T>(session: string, receiptAuthority: () => boolean, run: () => T) {
  return withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: `agent:main:${session}`, receiptAuthority },
    run,
  );
}

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

export function afterFileRead(filePath: string, complete: () => void, append = false) {
  interceptOpen(
    filePath,
    (handle) => {
      const read = handle.read.bind(handle);
      handle.read = (async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        complete();
        return result;
      }) as typeof handle.read;
    },
    (flags) =>
      append ? typeof flags === "number" && (flags & constants.O_APPEND) !== 0 : flags === "r+",
  );
}
