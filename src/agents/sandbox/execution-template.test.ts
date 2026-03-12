import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getExecutionSandboxTemplate,
  listExecutionSandboxTemplates,
  materializeExecutionSandboxTemplate,
  validateExecutionSandboxSources,
} from "./execution-template.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-execution-template-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("execution sandbox templates", () => {
  it("returns stable, immutable template snapshots", () => {
    const first = getExecutionSandboxTemplate("ts-research-v1");
    first.files["src/main.ts"] = "mutated";

    const second = getExecutionSandboxTemplate("ts-research-v1");
    expect(second.fingerprint).toBe(listExecutionSandboxTemplates()[0]?.fingerprint);
    expect(second.files["src/main.ts"]).toContain("summarizeDecision");
    expect(Object.keys(second.files).toSorted()).toEqual([
      "README.md",
      "package.json",
      "src/lib/decision-log.ts",
      "src/main.ts",
      "tsconfig.json",
    ]);
  });

  it("materializes deterministic files and refuses accidental overwrite", async () => {
    const destinationDir = await createTempDir();

    const result = await materializeExecutionSandboxTemplate({
      destinationDir,
      id: "ts-research-v1",
    });
    expect(result.writtenFiles).toHaveLength(5);

    const writtenMain = await fs.readFile(path.join(destinationDir, "src/main.ts"), "utf8");
    expect(writtenMain).toContain('import assert from "node:assert/strict"');

    await expect(
      materializeExecutionSandboxTemplate({
        destinationDir,
        id: "ts-research-v1",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("accepts the built-in template sources", () => {
    const template = getExecutionSandboxTemplate("ts-research-v1");

    const result = validateExecutionSandboxSources({
      template,
      files: template.files,
    });

    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it("rejects explicitly blocked runtime imports", () => {
    const template = getExecutionSandboxTemplate("ts-research-v1");

    const result = validateExecutionSandboxSources({
      template,
      files: {
        ...template.files,
        "src/bad.ts": 'import { execSync } from "node:child_process";\n',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "blocked-bare-import",
        filePath: "src/bad.ts",
        specifier: "node:child_process",
      }),
    );
  });

  it("rejects packages outside the allowlist", () => {
    const template = getExecutionSandboxTemplate("ts-research-v1");

    const result = validateExecutionSandboxSources({
      template,
      files: {
        ...template.files,
        "src/strategy.ts": 'import pandas from "pandas";\nexport default pandas;\n',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unallowlisted-bare-import",
        filePath: "src/strategy.ts",
        specifier: "pandas",
      }),
    );
  });

  it("rejects non-literal dynamic imports and sandbox escapes", () => {
    const template = getExecutionSandboxTemplate("ts-research-v1");

    const result = validateExecutionSandboxSources({
      template,
      files: {
        ...template.files,
        "src/dynamic.ts": 'const target = "./lib/decision-log.js";\nawait import(target);\n',
        "src/nested/escape.ts": 'import "../../../outside.js";\n',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "non-literal-import",
          filePath: "src/dynamic.ts",
        }),
        expect.objectContaining({
          code: "relative-import-escape",
          filePath: "src/nested/escape.ts",
          specifier: "../../../outside.js",
        }),
      ]),
    );
  });
});
