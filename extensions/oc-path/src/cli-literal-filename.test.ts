import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestRuntime,
  pathFindCommand,
  pathResolveCommand,
  stdoutText,
} from "./cli.test-support.js";

describe("openclaw path CLI literal filenames", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.runIf(process.platform !== "win32")(
    "finds quoted question-mark filenames and returns resolvable scoped paths",
    async () => {
      const workspaceDir = tempDirs.make("oc-path-cli-");
      const filePath = join(workspaceDir, "report?.jsonc");
      const before = '{"items":{"one":{"name":"first"},"two":{"name":"second"}}}';
      writeFileSync(filePath, before, "utf-8");
      const options = { cwd: workspaceDir, json: true };
      const rt = createTestRuntime();
      await pathFindCommand('oc://"report?.jsonc"/items/*/name?session=proof', options, rt);
      expect(rt.exitCode).toBe(0);
      const out = JSON.parse(stdoutText(rt));
      expect(out.count).toBe(2);
      expect(out.matches).toMatchObject([
        {
          path: 'oc://"report?.jsonc"/items/one/name?session=proof',
          match: { valueText: "first" },
        },
        {
          path: 'oc://"report?.jsonc"/items/two/name?session=proof',
          match: { valueText: "second" },
        },
      ]);
      for (const { path, match } of out.matches) {
        const resolved = createTestRuntime();
        await pathResolveCommand(path, options, resolved);
        expect(resolved.exitCode).toBe(0);
        expect(JSON.parse(stdoutText(resolved))).toMatchObject({ resolved: true, match });
      }
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    },
  );
});
