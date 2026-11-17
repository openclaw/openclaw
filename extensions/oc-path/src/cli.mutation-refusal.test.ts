import { promises as fs } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRuntime, pathSetCommand, stdoutText } from "./cli.test-support.js";

describe("path set refuses invalid mutations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { file: "X.yaml", raw: "name: x\n", path: "name", value: "{}", valueJson: true },
    {
      file: "X.md",
      raw: "---\nname: x\n---\n",
      path: "[frontmatter]/name",
      value: "{}",
      valueJson: true,
    },
    {
      file: "X.md",
      raw: "---\nname: x\n---\n",
      path: "[frontmatter]/name/absent",
      value: "y",
      valueJson: false,
    },
    {
      file: "X.md",
      raw: "---\nname: x\n---\n",
      path: "[frontmatter]/name/+added",
      value: "y",
      valueJson: false,
    },
  ])(
    "leaves $file unchanged for $path (valueJson=$valueJson)",
    async ({ file, raw, path, value, valueJson }) => {
      const cwd = tempDirs.make("oc-path-refusal-");
      const filePath = join(cwd, file);
      await fs.writeFile(filePath, raw);
      const rt = createTestRuntime();
      await pathSetCommand(`oc://${file}/${path}`, value, { cwd, valueJson, json: true }, rt);
      expect(rt.exitCode).toBe(1);
      expect(JSON.parse(stdoutText(rt))).toMatchObject({ ok: false });
      expect(await fs.readFile(filePath, "utf8")).toBe(raw);
    },
  );
});
