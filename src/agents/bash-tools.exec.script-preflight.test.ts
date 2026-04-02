import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec.js";

const isWin = process.platform === "win32";

const describeNonWin = isWin ? describe.skip : describe;
const describeWin = isWin ? describe : describe.skip;

describeNonWin("exec script preflight", () => {
  it("blocks shell env var injection tokens in python scripts before execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
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

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call1", {
          command: "python bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("blocks obvious shell-as-js output before node execution", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");

      await fs.writeFile(
        jsPath,
        ['NODE "$TMPDIR/hot.json"', "console.log('hi')"].join("\n"),
        "utf-8",
      );

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

  it("blocks shell env var injection when script path is quoted", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-quoted", {
          command: 'node "bad.js"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates the first positional python script operand when extra args follow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "ghost.py"), "print('ok')", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-python-first-script", {
          command: "python bad.py ghost.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates python script operand even when trailing option values look like scripts", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "script.py"), "payload = $DM_JSON", "utf-8");
      await fs.writeFile(path.join(tmp, "out.py"), "print('ok')", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-python-trailing-option-value", {
          command: "python script.py --output out.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("validates the first positional node script operand when extra args follow", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "app.js"), "const value = $DM_JSON;", "utf-8");
      await fs.writeFile(path.join(tmp, "config.js"), "console.log('ok')", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-node-first-script", {
          command: "node app.js config.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("still resolves node script when --require consumes a preceding .js option value", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bootstrap.js"), "console.log('bootstrap')", "utf-8");
      await fs.writeFile(path.join(tmp, "app.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-node-require-script", {
          command: "node --require bootstrap.js app.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("skips preflight file reads for script paths outside the workdir", async () => {
    await withTempDir("openclaw-exec-preflight-parent-", async (parent) => {
      const outsidePath = path.join(parent, "outside.js");
      const workdir = path.join(parent, "workdir");
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(outsidePath, "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-outside", {
        command: "node ../outside.js",
        workdir,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("fails closed for piped interpreter commands that bypass direct script parsing", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-pipe", {
          command: "cat bad.py | python",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap", {
          command: 'bash -c "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations with combined shell flags", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-combined", {
          command: 'bash -xc "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for shell-wrapped interpreter invocations when -c is not the trailing short flag", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-shell-wrap-short-flags", {
          command: 'bash -ceu "python bad.py"',
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("fails closed for process-substitution interpreter invocations", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const pyPath = path.join(tmp, "bad.py");
      await fs.writeFile(pyPath, "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call-process-substitution", {
          command: "python <(cat bad.py)",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: complex interpreter invocation detected/);
    });
  });

  it("allows direct inline interpreter commands with no script file hint", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-inline", {
        command: 'node -e "console.log(123)"',
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("123");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed when interpreter and script hints only appear in echoed text", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-echo-text", {
        command: "echo 'python bad.py | python'",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("python bad.py | python");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });

  it("does not fail closed for node -e when .py appears inside quoted inline code", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call-inline-script-hint", {
        command: "node -e \"console.log('bad.py')\"",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).toContain("bad.py");
      expect(text).not.toMatch(/exec preflight:/);
    });
  });
});

describeWin("exec script preflight on windows path syntax", () => {
  it("preserves windows-style python relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.py"), "payload = $DM_JSON", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-win-python-relative", {
          command: "python .\\bad.py",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style node relative path separators during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      await fs.writeFile(path.join(tmp, "bad.js"), "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-win-node-relative", {
          command: "node .\\bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });

  it("preserves windows-style python absolute drive paths during script extraction", async () => {
    await withTempDir("openclaw-exec-preflight-win-", async (tmp) => {
      const absPath = path.join(tmp, "bad.py");
      await fs.writeFile(absPath, "payload = $DM_JSON", "utf-8");
      const winAbsPath = absPath.replaceAll("/", "\\");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await expect(
        tool.execute("call-win-python-absolute", {
          command: `python "${winAbsPath}"`,
          workdir: tmp,
        }),
      ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
    });
  });
});
