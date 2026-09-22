import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { validateScriptFileForShellBleed } from "./bash-tools.exec-script-preflight.js";

it("bounds literal-tilde script reads when the file grows after inspection", async () => {
  await withTempDir("openclaw-exec-preflight-growth-", async (tmp) => {
    const scriptPath = path.join(tmp, "~", "growing.js");
    await fs.mkdir(path.dirname(scriptPath));
    await fs.writeFile(scriptPath, 'console.log("ok");');
    const maxBytes = 512 * 1024;
    const growingContent = Buffer.alloc(maxBytes * 2, 0x62);
    growingContent[maxBytes + 1] = 0x61;
    let unreadByte: number | undefined;
    const open = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== scriptPath) {
        return handle;
      }
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const initial = await stat();
        await fs.writeFile(scriptPath, growingContent);
        return initial;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        const next = Buffer.alloc(1);
        const { bytesRead } = await handle.read(next, 0, 1, null);
        unreadByte = bytesRead ? next[0] : undefined;
        await close();
      });
      return handle;
    });
    try {
      await validateScriptFileForShellBleed({
        command: 'node "~/growing.js"',
        workdir: tmp,
      });
      expect(unreadByte).toBe(0x61);
    } finally {
      openSpy.mockRestore();
    }
  });
});
