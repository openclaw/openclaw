import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRuntime,
  pathFindCommand,
  pathResolveCommand,
  pathSetCommand,
  stdoutText,
} from "./cli.test-support.js";

describe("openclaw path CLI wildcard array paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("returns reusable paths for literal wildcard keys in JSON mappings", async () => {
    const workspaceDir = tempDirs.make("oc-path-cli-");
    const filePath = join(workspaceDir, "config.jsonc");
    const paths: Record<string, string[]> = {
      "*": ["types/*"],
      "**": ["recursive/*"],
      "@app/*": ["src/*"],
      "types*": ["generated/*"],
    };
    writeFileSync(filePath, JSON.stringify({ paths }), "utf-8");
    const options = { cwd: workspaceDir, json: true };
    const rt = createTestRuntime();
    await pathFindCommand("oc://config.jsonc/paths/*", options, rt);
    expect(rt.exitCode).toBe(0);
    const out = JSON.parse(stdoutText(rt));
    expect(out.count).toBe(4);
    expect(out.matches.map((match: { path: string }) => match.path)).toEqual([
      'oc://config.jsonc/paths/"*"',
      'oc://config.jsonc/paths/"**"',
      'oc://config.jsonc/paths/"@app/*"',
      "oc://config.jsonc/paths/types*",
    ]);

    for (const [index, key] of Object.keys(paths).entries()) {
      const resultPath = out.matches[index].path;
      const resolved = createTestRuntime();
      await pathResolveCommand(resultPath, options, resolved);
      expect(resolved.exitCode).toBe(0);
      expect(JSON.parse(stdoutText(resolved))).toMatchObject({
        resolved: true,
        match: { kind: "node", descriptor: "jsonc-array" },
      });

      const updated = [`updated/${key}`];
      const written = createTestRuntime();
      await pathSetCommand(
        resultPath,
        JSON.stringify(updated),
        { ...options, valueJson: true },
        written,
      );
      expect(written.exitCode).toBe(0);
      expect(JSON.parse(stdoutText(written)).ok).toBe(true);
      paths[key] = updated;
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ paths });
    }
  });
});
