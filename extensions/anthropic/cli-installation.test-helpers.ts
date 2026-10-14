import fs from "node:fs/promises";
import path from "node:path";
import type { ClaudeCommandContext } from "./cli-installation.js";

export async function writeClaudeFixtureProgram(file: string, source: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

export type FixtureMode = "native" | "homebrew" | "npm";
export async function createClaudeInstallationFixture(
  temporaryRoot: string,
  mode: FixtureMode = "native",
  cask = "claude-code@latest",
) {
  const root = await fs.realpath(temporaryRoot);
  const home = path.join(root, "home");
  const prefix = mode === "native" ? path.join(home, ".local") : path.join(root, "prefix");
  const data = path.join(home, "data");
  const versions =
    mode === "native" ? path.join(data, "claude", "versions") : path.join(prefix, "Caskroom", cask);
  const packageRoot = path.join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
  const launcher = path.join(prefix, "bin", "claude");
  const previous =
    mode === "npm"
      ? path.join(packageRoot, "cli.cjs")
      : mode === "native"
        ? path.join(versions, "2.1.269")
        : path.join(versions, "2.1.269", "claude");
  const next =
    mode === "native" ? path.join(versions, "2.1.286") : path.join(versions, "2.1.286", "claude");
  const log = path.join(root, "calls.jsonl");
  const settings = path.join(root, "fixture.json");
  const versionFile = path.join(root, "version");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(versionFile, "2.1.269");
  const config = {
    root,
    home,
    data,
    prefix,
    versions,
    packageRoot,
    launcher,
    previous,
    next,
    log,
    versionFile,
    cask,
    brewListedCask: cask,
    mode,
    noChange: false,
    fail: false,
    npmPrefix: prefix,
    npmVersion: "11.16.0",
  };
  await fs.writeFile(settings, JSON.stringify(config));
  const prelude = `
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const c = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, "utf8"));
assert.equal(process.env.HOME, c.home);
assert.equal(process.env.XDG_DATA_HOME, c.data);
assert.equal(process.env.OPENCLAW_STATE_DIR, path.join(c.home, "state"));
assert.equal(process.env.npm_config_cache, path.join(c.home, "npm-cache"));
assert.equal(process.env.npm_config_userconfig, path.join(c.home, "npmrc"));
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
assert.equal(process.cwd(), c.home);
const args = process.argv.slice(2);
fs.appendFileSync(c.log, JSON.stringify({ program: process.argv[1], args }) + "\\n");
`;
  const update = `
if (c.fail) process.exit(1);
if (!c.noChange) {
  if (c.mode !== "npm") {
    fs.unlinkSync(c.launcher);
    fs.symlinkSync(c.next, c.launcher);
  }
  fs.writeFileSync(c.versionFile, "2.1.286");
}
`;
  const claude = `${prelude}
if (args[0] === "--version") {
  const selected = fs.realpathSync(process.argv[1]);
  const version = c.mode === "native" ? path.basename(selected) : c.mode === "homebrew" ? path.basename(path.dirname(selected)) : fs.readFileSync(c.versionFile, "utf8");
  process.stdout.write(version + " (Claude Code)");
} else if (args[0] === "update" && c.mode === "native") { ${update} }
else process.exit(2);
`;
  await writeClaudeFixtureProgram(previous, claude);
  if (mode !== "npm") {
    await writeClaudeFixtureProgram(next, claude);
  }
  await fs.symlink(previous, launcher);
  if (mode === "homebrew") {
    await writeClaudeFixtureProgram(
      path.join(prefix, "bin", "brew"),
      `${prelude}
if (args[0] === "--caskroom") { assert.equal(args[1], c.cask); process.stdout.write(c.versions); }
else if (args[0] === "list") { assert.deepEqual(args.slice(1), ["--cask", "--versions", c.cask]); process.stdout.write(c.brewListedCask + " " + fs.readFileSync(c.versionFile, "utf8")); }
else if (args[0] === "upgrade") {
  assert.deepEqual(args.slice(1), ["--cask", c.cask]);
  assert.equal(process.env.HOMEBREW_NO_INSTALL_CLEANUP, "1");
  assert.equal(process.env.HOMEBREW_NO_AUTO_UPDATE, undefined);
  ${update}
}
else process.exit(2);
`,
    );
  }
  if (mode === "npm") {
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/claude-code",
        version: "2.1.269",
        bin: { claude: "cli.cjs" },
      }),
    );
    await writeClaudeFixtureProgram(
      path.join(prefix, "bin", "npm"),
      `${prelude}
if (args[0] === "prefix") { assert.deepEqual(args, ["prefix", "--global"]); process.stdout.write(c.npmPrefix); }
else if (args[0] === "--version") process.stdout.write(c.npmVersion);
else if (args[0] === "install") {
  assert.deepEqual(args, ["install", "--global", "--prefix", c.prefix, "@anthropic-ai/claude-code@latest", "--no-audit", "--no-fund", ...(c.npmVersion === "11.16.0" ? ["--allow-scripts=@anthropic-ai/claude-code"] : [])]);
  ${update}
} else process.exit(2);
`,
    );
  }
  const context: ClaudeCommandContext = {
    command: "claude",
    env: {
      PATH: path.dirname(launcher),
      HOME: home,
      XDG_DATA_HOME: data,
      OPENCLAW_STATE_DIR: path.join(home, "state"),
      npm_config_cache: path.join(home, "npm-cache"),
      npm_config_userconfig: path.join(home, "npmrc"),
    },
    assertCurrent: () => {},
  };
  return {
    ...config,
    context,
    change: async (patch: Partial<typeof config>) => {
      const current = JSON.parse(await fs.readFile(settings, "utf8")) as typeof config;
      await fs.writeFile(settings, JSON.stringify({ ...current, ...patch }));
    },
    calls: async () =>
      fs
        .readFile(log, "utf8")
        .then((raw) =>
          raw
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { program: string; args: string[] }),
        )
        .catch((error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return [];
          }
          throw error;
        }),
  };
}
