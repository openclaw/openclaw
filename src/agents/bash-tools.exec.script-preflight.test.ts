import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createExecTool } from "./bash-tools.exec.js";

const isWin = process.platform === "win32";

const describeNonWin = isWin ? describe.skip : describe;

describeNonWin("exec script preflight", () => {
  it("blocks sandboxed node scripts that import denied runtime modules", async () => {
    await withTempDir("openclaw-exec-preflight-sandbox-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(
        jsPath,
        [
          'const { execSync } = require("node:child_process");',
          "console.log(typeof execSync);",
        ].join("\n"),
        "utf-8",
      );

      const tool = createExecTool({
        host: "sandbox",
        security: "full",
        ask: "off",
        sandbox: {
          containerName: "openclaw-test-sandbox",
          workspaceDir: tmp,
          containerWorkdir: "/workspace",
        },
      });

      await expect(
        tool.execute("call-sandbox-blocked", {
          command: "node bad.js",
          workdir: tmp,
        }),
      ).rejects.toThrow(/sandbox template "node-research" blocks import "node:child_process"/);
    });
  });

  it("keeps import-template validation sandbox-only for host exec", async () => {
    await withTempDir("openclaw-exec-preflight-host-", async (tmp) => {
      const jsPath = path.join(tmp, "host-ok.js");
      await fs.writeFile(
        jsPath,
        [
          'const { execSync } = require("node:child_process");',
          "console.log(typeof execSync);",
        ].join("\n"),
        "utf-8",
      );

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call-host-allowed", {
        command: "node host-ok.js",
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";

      expect(text).toContain("function");
      expect(text).not.toContain('sandbox template "node-research"');
    });
  });

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

  it("skips preflight when script token is quoted and unresolved by fast parser", async () => {
    await withTempDir("openclaw-exec-preflight-", async (tmp) => {
      const jsPath = path.join(tmp, "bad.js");
      await fs.writeFile(jsPath, "const value = $DM_JSON;", "utf-8");

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call-quoted", {
        command: 'node "bad.js"',
        workdir: tmp,
      });
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      expect(text).not.toMatch(/exec preflight:/);
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
});
