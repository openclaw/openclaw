import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ircImportEnv = {
  HOME: process.env.HOME,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  NODE_PATH: process.env.NODE_PATH,
  PATH: process.env.PATH,
  TERM: process.env.TERM,
} satisfies NodeJS.ProcessEnv;

describe("irc bundled api seams", () => {
  it("loads the narrow channel plugin api in direct smoke", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'const mod = await import("./extensions/irc/channel-plugin-api.ts"); process.stdout.write(JSON.stringify({keys:Object.keys(mod).sort(), id: mod.ircPlugin.id}));',
      ],
      {
        cwd: repoRoot,
        env: ircImportEnv,
        timeout: 40_000,
      },
    );

    expect(stdout).toBe('{"keys":["ircPlugin"],"id":"irc"}');
  }, 45_000);

  it("loads the narrow runtime api in direct smoke", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'const mod = await import("./extensions/irc/runtime-api.ts"); process.stdout.write(JSON.stringify({keys:Object.keys(mod).sort(), type: typeof mod.setIrcRuntime}));',
      ],
      {
        cwd: repoRoot,
        env: ircImportEnv,
        timeout: 40_000,
      },
    );

    expect(stdout).toBe('{"keys":["setIrcRuntime"],"type":"function"}');
  }, 45_000);
});
