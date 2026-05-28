import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("post-cron-learner cli entrypoint", () => {
  it("runs as direct script and reports missing report path safely", () => {
    const scriptPath = path.join(
      process.cwd(),
      "extensions",
      "evolution-learning",
      "hooks",
      "post-cron-learner.js",
    );
    const missingReportPath = path.join(
      process.cwd(),
      ".tmp",
      "__post-cron-learner-missing-report__.json",
    );

    const stdout = execFileSync(process.execPath, [scriptPath, missingReportPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const result = JSON.parse(stdout) as { ok?: boolean; reason?: string };

    expect(result).toMatchObject({
      ok: false,
      reason: "report not found",
    });
  });

  it("does not execute main when imported as a module", () => {
    const scriptPath = path.join(
      process.cwd(),
      "extensions",
      "evolution-learning",
      "hooks",
      "post-cron-learner.js",
    );
    const code = [
      'import { pathToFileURL } from "node:url";',
      `await import(pathToFileURL(${JSON.stringify(scriptPath)}).href);`,
      'process.stdout.write("import-ok");',
    ].join("\n");
    const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();

    expect(stdout).toBe("import-ok");
  });
});
