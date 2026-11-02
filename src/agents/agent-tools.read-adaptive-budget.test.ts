import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createSandboxedReadTool } from "./agent-tools.read.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

it("names the model context budget when adaptive paging is budget-bound", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-budget-"));
  try {
    // 16600 CJK characters stay under the 50KB byte cap but weigh 66400 toward a
    // 32000-char context budget, so only the budget can end this page.
    await fs.writeFile(path.join(root, "budget.txt"), "你".repeat(16_600));
    const readTool = createSandboxedReadTool({
      root,
      bridge: createHostSandboxFsBridge(root),
      modelContextWindowTokens: 128_000,
    });

    const result = await readTool.execute("read-cjk-budget", { path: "budget.txt" });
    const text = getTextContent(result);

    expect(text).toContain("model context budget");
    expect(text).not.toContain("50KB");
    expect(text).toMatch(/Use offset=1(, cursor=\d+)? to continue\.\]$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
