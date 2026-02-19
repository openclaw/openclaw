import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const isWin = process.platform === "win32";

describe("exec script preflight", () => {
  it("blocks shell env var injection tokens in python scripts before execution", async () => {
    if (isWin) {
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-"));
    const pyPath = path.join(tmp, "bad.py");

    await fs.writeFile(
      pyPath,
      [
        "import json",
        "# model accidentally wrote shell syntax:",
        "payload = $DM_JSON",
        "print(payload)",
      ].join("\n"),
      "utf-8",
    );

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "python bad.py",
        workdir: tmp,
      }),
    ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
  });

  it("blocks obvious shell-as-js output before node execution", async () => {
    if (isWin) {
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-"));
    const jsPath = path.join(tmp, "bad.js");

    await fs.writeFile(
      jsPath,
      ['NODE "$TMPDIR/hot.json"', "console.log('hi')"].join("\n"),
      "utf-8",
    );

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "node bad.js",
        workdir: tmp,
      }),
    ).rejects.toThrow(
      /exec preflight: (detected likely shell variable injection|JS file starts with shell syntax)/,
    );
  });
});
