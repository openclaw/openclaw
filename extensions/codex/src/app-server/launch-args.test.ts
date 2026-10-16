import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexPrivateLauncher } from "./launch-args.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("private Codex launcher arguments", () => {
  it("rebases the wrapper and file preloads while preserving Node runtime options", () => {
    const cwd = path.resolve("/original/project");
    const nativeArgs = [
      "--profile",
      "app-server",
      "-c",
      "features.hooks=true",
      "app-server",
      "--listen",
      "stdio://",
    ];
    const result = resolveCodexPrivateLauncher({
      command: "node",
      cwd,
      args: [
        "--enable-source-maps",
        "--max-old-space-size=4096",
        "-r./register.cjs",
        "--import",
        "./loader.mjs",
        "./bin/wrapper.js",
        ...nativeArgs,
      ],
    });
    expect(result.launcherArgs).toEqual([
      "--enable-source-maps",
      "--max-old-space-size=4096",
      "-r",
      path.join(cwd, "register.cjs"),
      "--import",
      path.join(cwd, "loader.mjs"),
      path.join(cwd, "bin/wrapper.js"),
    ]);
    expect(result.nativeArgs).toEqual(nativeArgs);
  });

  it("resolves package preloads in the original cwd without executing them", async () => {
    const cwd = tempDirs.make("codex-wrapper-module-");
    const moduleDir = path.join(cwd, "node_modules", "codex-wrapper-preload");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, "package.json"), '{"main":"index.cjs"}');
    await fs.writeFile(
      path.join(moduleDir, "index.cjs"),
      'throw new Error("do not execute while preparing");',
    );
    expect(
      resolveCodexPrivateLauncher({
        command: "node",
        cwd,
        args: ["--require", "codex-wrapper-preload", "wrapper.js", "app-server"],
      }).launcherArgs,
    ).toEqual([
      "--require",
      await fs.realpath(path.join(moduleDir, "index.cjs")),
      path.join(cwd, "wrapper.js"),
    ]);
  });

  it("preserves a Node option terminator before its script", () => {
    const cwd = path.resolve("/original/project");
    expect(
      resolveCodexPrivateLauncher({
        command: "node",
        cwd,
        args: ["--", "wrapper.js", "app-server"],
      }),
    ).toEqual({
      launcherArgs: ["--", path.join(cwd, "wrapper.js")],
      nativeArgs: ["app-server"],
    });
  });

  it("does not mistake native root option values for launcher arguments", () => {
    const args = [
      "--profile",
      "app-server",
      "-c",
      'openai_base_url="https://example.test"',
      "app-server",
    ];
    expect(resolveCodexPrivateLauncher({ command: "codex", cwd: process.cwd(), args })).toEqual({
      launcherArgs: [],
      nativeArgs: args,
    });
  });

  it.each([
    { command: "node", args: ["-e", "require('wrapper')", "app-server"] },
    { command: "node", args: ["wrapper.js", "--", "-c", "opaque", "app-server"] },
    { command: "python3", args: ["wrapper.py", "app-server"] },
  ])("rejects ambiguous or unsupported interpreted launchers %#", ({ command, args }) => {
    expect(() => resolveCodexPrivateLauncher({ command, args, cwd: process.cwd() })).toThrow(
      /Private Codex turns cannot isolate/,
    );
  });
});
