import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const zaloRuntimeImportEnv = {
  HOME: process.env.HOME,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  NODE_PATH: process.env.NODE_PATH,
  PATH: process.env.PATH,
  TERM: process.env.TERM,
} satisfies NodeJS.ProcessEnv;

describe("zalo runtime api", () => {
  it("exports the channel plugin without reentering setup surfaces", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'const runtimeApi = await import("./extensions/zalo/runtime-api.ts"); process.stdout.write(runtimeApi.zaloPlugin.id);',
      ],
      {
        cwd: repoRoot,
        env: zaloRuntimeImportEnv,
        timeout: 40_000,
      },
    );

    expect(stdout).toBe("zalo");
  }, 45_000);
});
