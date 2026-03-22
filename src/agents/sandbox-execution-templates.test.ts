import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  extractSandboxExecutionTargetFromCommand,
  validateSandboxExecutionTemplateImports,
} from "./sandbox-execution-templates.js";

describe("sandbox execution templates", () => {
  it("extracts direct python and node script targets from simple exec commands", () => {
    expect(extractSandboxExecutionTargetFromCommand("python3 -u scripts/run.py")).toEqual({
      kind: "python",
      templateId: "python-research",
      relOrAbsPath: "scripts/run.py",
    });
    expect(extractSandboxExecutionTargetFromCommand("node --trace-warnings tools/run.mjs")).toEqual(
      {
        kind: "node",
        templateId: "node-research",
        relOrAbsPath: "tools/run.mjs",
      },
    );
    expect(extractSandboxExecutionTargetFromCommand('node "quoted.js"')).toBeNull();
  });

  it("allows python stdlib imports and workspace-local helper modules", async () => {
    await withTempDir("openclaw-sandbox-template-python-", async (tmp) => {
      const mainPath = path.join(tmp, "research.py");
      await fs.writeFile(path.join(tmp, "helpers.py"), "VALUE = 1\n", "utf-8");
      await fs.writeFile(
        mainPath,
        ["import math", "import helpers", "from collections import Counter", "print(math.pi)"].join(
          "\n",
        ),
        "utf-8",
      );

      const content = await fs.readFile(mainPath, "utf-8");
      expect(() =>
        validateSandboxExecutionTemplateImports({
          kind: "python",
          filePath: mainPath,
          workdir: tmp,
          content,
        }),
      ).not.toThrow();
    });
  });

  it("blocks unsafe python process imports with an actionable sandbox-template error", async () => {
    await withTempDir("openclaw-sandbox-template-python-", async (tmp) => {
      const mainPath = path.join(tmp, "research.py");
      await fs.writeFile(mainPath, ["import json", "import subprocess"].join("\n"), "utf-8");

      const content = await fs.readFile(mainPath, "utf-8");
      expect(() =>
        validateSandboxExecutionTemplateImports({
          kind: "python",
          filePath: mainPath,
          workdir: tmp,
          content,
        }),
      ).toThrow(/sandbox template "python-research" blocks import "subprocess"/);
    });
  });

  it("blocks non-allowlisted python third-party dependencies", async () => {
    await withTempDir("openclaw-sandbox-template-python-", async (tmp) => {
      const mainPath = path.join(tmp, "research.py");
      await fs.writeFile(mainPath, "import pandas\n", "utf-8");

      const content = await fs.readFile(mainPath, "utf-8");
      expect(() =>
        validateSandboxExecutionTemplateImports({
          kind: "python",
          filePath: mainPath,
          workdir: tmp,
          content,
        }),
      ).toThrow(/Only deterministic stdlib imports and workspace-local modules are allowed/);
    });
  });

  it("allows node builtins on the template allowlist and relative helper imports", async () => {
    await withTempDir("openclaw-sandbox-template-node-", async (tmp) => {
      const mainPath = path.join(tmp, "research.mjs");
      await fs.writeFile(path.join(tmp, "helpers.mjs"), "export const value = 1;\n", "utf-8");
      await fs.writeFile(
        mainPath,
        [
          'import path from "node:path";',
          'import { value } from "./helpers.mjs";',
          "console.log(path.basename(import.meta.url), value);",
        ].join("\n"),
        "utf-8",
      );

      const content = await fs.readFile(mainPath, "utf-8");
      expect(() =>
        validateSandboxExecutionTemplateImports({
          kind: "node",
          filePath: mainPath,
          workdir: tmp,
          content,
        }),
      ).not.toThrow();
    });
  });

  it("blocks unsafe node runtime dependencies and dynamic require calls", async () => {
    await withTempDir("openclaw-sandbox-template-node-", async (tmp) => {
      const blockedPath = path.join(tmp, "blocked.mjs");
      await fs.writeFile(
        blockedPath,
        'import { execSync } from "node:child_process";\nconsole.log(execSync);\n',
        "utf-8",
      );

      const blockedContent = await fs.readFile(blockedPath, "utf-8");
      expect(() =>
        validateSandboxExecutionTemplateImports({
          kind: "node",
          filePath: blockedPath,
          workdir: tmp,
          content: blockedContent,
        }),
      ).toThrow(/sandbox template "node-research" blocks import "node:child_process"/);

      const dynamicPath = path.join(tmp, "dynamic.cjs");
      await fs.writeFile(dynamicPath, "const name = process.argv[2];\nrequire(name);\n", "utf-8");
      const dynamicContent = await fs.readFile(dynamicPath, "utf-8");
      expect(() =>
        validateSandboxExecutionTemplateImports({
          kind: "node",
          filePath: dynamicPath,
          workdir: tmp,
          content: dynamicContent,
        }),
      ).toThrow(/Dynamic require\(\) calls are not allowed/);
    });
  });
});
