import { writeFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expect, it, vi, type MockInstance } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { validateScriptFileForShellBleed } from "./bash-tools.exec-script-preflight.js";

it("bounds literal-tilde script reads when the file grows after inspection", async () => {
  await withTempDir("openclaw-exec-preflight-growth-", async (tmp) => {
    const scriptPath = path.join(tmp, "~", "growing.py");
    await fs.mkdir(path.dirname(scriptPath));
    await fs.writeFile(scriptPath, 'print("ok")');
    const scriptRealPath = await fs.realpath(scriptPath);
    const maxBytes = 512 * 1024;
    const growingContent = Buffer.alloc(maxBytes * 2, 0x62);
    growingContent[maxBytes + 1] = 0x61;
    let unreadByte: number | undefined;
    let closeSpy: MockInstance<FileHandle["close"]> | undefined;
    __setFsSafeTestHooksForTest({
      afterRootReadFinalPathIdentityCheck: (filePath, handle) => {
        if (filePath !== scriptRealPath) {
          return;
        }
        writeFileSync(scriptPath, growingContent);
        const close = handle.close.bind(handle);
        closeSpy = vi.spyOn(handle, "close").mockImplementation(async () => {
          const next = Buffer.alloc(1);
          const { bytesRead } = await handle.read(next, 0, 1, null);
          unreadByte = bytesRead ? next[0] : undefined;
          await close();
        });
      },
    });
    try {
      await validateScriptFileForShellBleed({
        command: 'python3 "~/growing.py"',
        workdir: tmp,
      });
      expect(unreadByte).toBe(0x61);
    } finally {
      __setFsSafeTestHooksForTest(undefined);
      closeSpy?.mockRestore();
    }
  });
});
