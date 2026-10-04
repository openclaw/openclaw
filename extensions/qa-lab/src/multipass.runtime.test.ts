// Qa Lab tests cover Multipass behavior through the production runner.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() => vi.fn());
const TEST_ENV_VALUE = "qa-fixture-value";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    runExec: runExecMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return { ...actual, sleep: sleepMock };
});

import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import { runQaMultipass } from "./multipass.runtime.js";

const generatedPaths: string[] = [];

function missingMultipassError() {
  return Object.assign(new Error("spawn multipass ENOENT"), { code: "ENOENT" });
}

async function renderPersistedGuestScript(
  params: Omit<Parameters<typeof runQaMultipass>[0], "repoRoot" | "outputDir"> & {
    outputDirName: string;
  },
) {
  const { outputDirName, ...runParams } = params;
  const outputDir = path.join(process.cwd(), ".artifacts", "qa-e2e", outputDirName);
  generatedPaths.push(outputDir);
  await expect(
    runQaMultipass({
      repoRoot: process.cwd(),
      outputDir,
      ...runParams,
    }),
  ).rejects.toThrow("Multipass is not installed on this host.");
  return fs.readFileSync(path.join(outputDir, "multipass-guest-run.sh"), "utf8");
}

async function captureGuestScriptsAtTransfer(
  params: Omit<Parameters<typeof runQaMultipass>[0], "repoRoot" | "outputDir"> & {
    outputDirName: string;
  },
) {
  const { outputDirName, ...runParams } = params;
  const outputDir = path.join(process.cwd(), ".artifacts", "qa-e2e", outputDirName);
  let executableScript = "";
  generatedPaths.push(outputDir);
  runExecMock.mockImplementation(async (_file: string, args: string[]) => {
    const transferSourcePath = args[1];
    if (
      args[0] === "transfer" &&
      transferSourcePath &&
      path.basename(transferSourcePath) === "guest-run.sh"
    ) {
      executableScript = fs.readFileSync(transferSourcePath, "utf8");
      throw new Error("stop after guest script transfer");
    }
    return { stdout: "", stderr: "" };
  });

  await expect(
    runQaMultipass({
      repoRoot: process.cwd(),
      outputDir,
      ...runParams,
    }),
  ).rejects.toThrow("stop after guest script transfer");

  expect(executableScript).not.toBe("");
  return {
    executableScript,
    persistedScript: fs.readFileSync(path.join(outputDir, "multipass-guest-run.sh"), "utf8"),
  };
}

describe("qa multipass runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sleepMock.mockResolvedValue(undefined);
    runExecMock.mockRejectedValue(missingMultipassError());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const generatedPath of generatedPaths.splice(0)) {
      fs.rmSync(generatedPath, { recursive: true, force: true });
    }
  });

  it.each([
    ["repo", 0],
    ["repo", 4],
    ["repo", 5],
    ["codex-home", 0],
    ["codex-home", 4],
    ["codex-home", 5],
  ] as const)("preserves %s mount lifecycle after %i failures", async (mount, failures) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mount-"));
    try {
      const configPath = path.join(tempRoot, "provider.json");
      fs.writeFileSync(configPath, "{}");
      vi.stubEnv("CODEX_HOME", tempRoot);
      vi.stubEnv("OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH", configPath);
      const outputDir = path.join(
        process.cwd(),
        ".artifacts",
        "qa-e2e",
        `mount-${mount}-${failures}`,
      );
      generatedPaths.push(outputDir);
      const destination =
        mount === "repo" ? "/workspace/openclaw-host" : "/workspace/openclaw-codex-home";
      const source = mount === "repo" ? process.cwd() : tempRoot;
      const label = mount === "repo" ? "mount" : "codex-home mount";
      const commands: string[][] = [];
      const attempts: Error[] = [];
      let mountCalls = 0;
      runExecMock.mockImplementation(async (_file: string, args: string[]) => {
        commands.push([...args]);
        if (args[0] === "mount" && args[2]?.endsWith(`:${destination}`)) {
          mountCalls += 1;
          if (mountCalls <= failures) {
            const error = Object.assign(new Error("process failure"), {
              stderr: `  mount failure ${mountCalls}  `,
              stdout: "ignored output",
            });
            attempts.push(error);
            throw error;
          }
        }
        if (args[0] === "exec" && args.length === 4) {
          fs.writeFileSync(path.join(outputDir, "qa-suite-report.md"), "fixture report");
          fs.writeFileSync(path.join(outputDir, "qa-suite-summary.json"), "{}");
        }
        return { stdout: "", stderr: "" };
      });

      const result = await runQaMultipass({
        repoRoot: process.cwd(),
        outputDir,
        providerMode: "live-frontier",
      }).catch((error: unknown) => error);
      if (failures === 5) {
        expect(result).toBeInstanceOf(Error);
        expect(((result as Error).cause as Error).cause).toBe(attempts.at(-1));
      } else {
        expect(result).toMatchObject({ outputDir });
      }

      const launch = commands.find((args) => args[0] === "launch");
      const vmName = launch?.[2];
      expect(vmName).toBeDefined();
      const selectedMounts = commands.filter(
        (args) => args[0] === "mount" && args[2] === `${vmName}:${destination}`,
      );
      expect(selectedMounts).toEqual(
        Array.from({ length: Math.min(failures + 1, 5) }, () => [
          "mount",
          source,
          `${vmName}:${destination}`,
        ]),
      );
      expect(sleepMock.mock.calls).toEqual(
        Array.from({ length: Math.min(failures, 4) }, () => [2_000]),
      );
      const log = fs.readFileSync(path.join(outputDir, "multipass-host.log"), "utf8");
      for (let attempt = 1; attempt <= failures; attempt += 1) {
        expect(log).toContain(`${label} retry ${attempt}/5: mount failure ${attempt}\n\n`);
      }
      const repoMountIndex = commands.findIndex(
        (args) => args[0] === "mount" && args[2]?.endsWith(":/workspace/openclaw-host"),
      );
      const homeMountIndex = commands.findIndex(
        (args) => args[0] === "mount" && args[2]?.endsWith(":/workspace/openclaw-codex-home"),
      );
      const configTransferIndex = commands.findIndex(
        (args) => args[0] === "transfer" && args[1] === configPath,
      );
      const scriptTransferIndex = commands.findIndex(
        (args) => args[0] === "transfer" && args[1] && path.basename(args[1]) === "guest-run.sh",
      );
      expect(repoMountIndex).toBeGreaterThan(-1);
      if (mount === "repo" && failures === 5) {
        expect(homeMountIndex).toBe(-1);
      } else {
        expect(homeMountIndex).toBeGreaterThan(repoMountIndex);
      }
      if (failures === 5) {
        expect(configTransferIndex).toBe(-1);
        expect(scriptTransferIndex).toBe(-1);
      } else {
        expect(configTransferIndex).toBeGreaterThan(homeMountIndex);
        expect(scriptTransferIndex).toBeGreaterThan(configTransferIndex);
        expect(fs.existsSync(commands[scriptTransferIndex]![1]!)).toBe(false);
      }
      expect(commands.at(-2)).toEqual([
        "transfer",
        `${vmName}:/tmp/${vmName}-bootstrap.log`,
        path.join(outputDir, "multipass-guest-bootstrap.log"),
      ]);
      expect(commands.at(-1)).toEqual(["delete", "--purge", vmName]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts repo-local output directory names beginning with two dots", async () => {
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "qa-multipass-output-" },
      async (workspace) => {
        await workspace.writeText(
          "package.json",
          JSON.stringify({ packageManager: "pnpm@10.32.1" }),
        );
        const outputDir = workspace.path("..qa-artifacts");

        await expect(
          runQaMultipass({ repoRoot: workspace.dir, outputDir, providerMode: "mock-openai" }),
        ).rejects.toThrow("Multipass is not installed on this host.");

        const script = fs.readFileSync(path.join(outputDir, "multipass-guest-run.sh"), "utf8");
        expect(script).toContain("'--output-dir' '..qa-artifacts'");
      },
    );
  });

  it("rejects output directories outside the mounted repo root", async () => {
    await expect(
      runQaMultipass({
        repoRoot: process.cwd(),
        outputDir: "/tmp/qa-out",
      }),
    ).rejects.toThrow(
      "qa suite --runner multipass requires --output-dir to stay under the repo root",
    );
  });

  it("rejects repo-local symlink output directories that escape the repo root", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-multipass-"));
    const repoRoot = path.join(tempRoot, "repo");
    const outsideRoot = path.join(tempRoot, "outside");
    const symlinkPath = path.join(repoRoot, "artifacts-link");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.32.1" }),
      "utf8",
    );
    fs.symlinkSync(outsideRoot, symlinkPath);

    try {
      await expect(
        runQaMultipass({
          repoRoot,
          outputDir: path.join(symlinkPath, "qa-out"),
        }),
      ).rejects.toThrow(
        "qa suite --runner multipass requires --output-dir to stay under the repo root",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists the default live suite command and mounted artifact path", async () => {
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-default-test",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
    });

    expect(script).toContain("pnpm install --frozen-lockfile");
    expect(script).toContain("pnpm build");
    expect(script).toContain("corepack prepare 'pnpm@");
    expect(script).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 120 "${base_url}/SHASUMS256.txt" -o "${node_tmp_dir}/SHASUMS256.txt"',
    );
    expect(script).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 120 "${base_url}/${tarball_name}" -o "${node_tmp_dir}/${tarball_name}"',
    );
    expect(script).toContain("'pnpm' 'openclaw' 'qa' 'suite' '--transport' 'qa-channel'");
    expect(script).toContain("'--provider-mode' 'live-frontier'");
    expect(script).toContain("'--scenario' 'channel-chat-baseline'");
    expect(script).toContain("'--scenario' 'thread-follow-up'");
    expect(script).toContain("/workspace/openclaw-host/.artifacts/qa-e2e/multipass-default-test");
  });

  it("forwards fail-fast to the real guest QA suite command", async () => {
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-fail-fast-test",
      failFast: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(script).toContain("'--fail-fast'");
  });

  it.skipIf(process.platform === "win32").each([
    ["missing", "24.99.0"],
    ["22.99.0", "24.99.0"],
    ["24.15.0", "24.99.0"],
    ["25.1.0", "24.99.0"],
    ["24.16.0", "24.16.0"],
    ["26.1.0", "24.99.0"],
  ])("bootstraps a runnable guest toolchain from Node %s", async (version, expectedVersion) => {
    const { executableScript } = await captureGuestScriptsAtTransfer({
      outputDirName: "multipass-node-" + version,
      providerMode: "mock-openai",
    });
    const vmName = runExecMock.mock.calls.find(([, args]) => args[0] === "launch")?.[1][2];
    generatedPaths.push("/tmp/" + vmName + "-bootstrap.log");
    await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "qa-multipass-bootstrap-" },
      async (workspace) => {
        const versionPath = await workspace.writeText("version", version);
        const scriptPath = await workspace.writeText("guest.sh", executableScript);
        const preloadPath = await workspace.writeText(
          "node-preload.mjs",
          [
            'import fs from "node:fs";',
            'import { registerHooks } from "node:module";',
            'import { pathToFileURL } from "node:url";',
            'Object.defineProperty(process.versions, "node", { value: fs.readFileSync(process.env.QA_TEST_NODE_VERSION, "utf8").trim() });',
            "registerHooks({ resolve(specifier, context, next) {",
            '  return next(specifier === "file:///workspace/openclaw-host/node-version.mjs"',
            '    ? pathToFileURL(process.env.QA_TEST_REPO_ROOT + "/node-version.mjs").href : specifier, context);',
            "} });",
          ].join("\n"),
        );
        const shellEnvPath = await workspace.writeText(
          "shell-env",
          [
            "command() {",
            '  if [[ "$*" == "-v corepack" ]]; then',
            '    case "$(<"$QA_TEST_NODE_VERSION")" in missing|25.*|26.*) return 1 ;; *) return 0 ;; esac',
            '  else builtin command "$@"; fi',
            "}",
            "node() {",
            '  [[ "$(<"$QA_TEST_NODE_VERSION")" != missing ]] || return 127',
            '  "$QA_TEST_NODE_EXEC" --import "$QA_TEST_NODE_PRELOAD" "$@"',
            "}",
            "corepack() {",
            "  command -v corepack >/dev/null || return 127",
            '  if [[ "$1" == prepare ]]; then printf "%s" "$2" > "$QA_TEST_PNPM_SPEC"; fi',
            "}",
            "sudo() {",
            '  case "$1" in',
            "    -E|mkdir|mount|rm|tar) return 0 ;;",
            "    ln)",
            '      if [[ "$4" == /usr/local/bin/node ]]; then',
            '        printf "%s" "$3" | sed -E "s|.*/node-v([^-]+)-.*|\\1|" > "$QA_TEST_NODE_VERSION"',
            "      fi ;;",
            '    env) shift 3; corepack "$@" ;;',
            "    *) return 1 ;;",
            "  esac",
            "}",
            "curl() {",
            "  local url output major",
            "  while (( $# )); do",
            '    case "$1" in https:*) url="$1"; shift ;; -o) output="$2"; shift 2 ;; *) shift ;; esac',
            "  done",
            '  major="$(printf "%s" "$url" | sed -E "s|.*/latest-v([0-9]+).x/.*|\\1|")"',
            '  printf "fixture node-v%s.99.0-linux-x64.tar.xz\\n" "$major" > "$output"',
            "}",
            "uname() { echo x86_64; }",
            "sha256sum() { cat >/dev/null; }",
            "rsync() { return 0; }",
            'mkdir() { [[ "$1" == -p && "$2" == /workspace* ]] || builtin command mkdir "$@"; }',
            'rm() { [[ "$*" == *"/workspace/openclaw"* ]] || builtin command rm "$@"; }',
            'cd() { if [[ "$1" == /workspace/openclaw ]]; then builtin cd "$QA_TEST_REPO_ROOT"; else builtin cd "$@"; fi; }',
            "pnpm() {",
            '  if [[ "$1" == openclaw ]]; then printf "%s\\0" "$@" > "$QA_TEST_SUITE_ARGS"; fi',
            '  [[ -f "$QA_TEST_PNPM_SPEC" ]] || return 1',
            '  node --input-type=commonjs -e \'const pkg = require("./package.json"); if (!require("semver").satisfies(process.versions.node, pkg.engines.node)) throw new Error("unsupported guest Node " + process.versions.node)\' || return',
            '  printf "%s:%s\\n" "$1" "$(<"$QA_TEST_NODE_VERSION")" >> "$QA_TEST_COMMANDS"',
            "}",
          ].join("\n"),
        );
        const pnpmSpecPath = workspace.path("pnpm-spec");
        const commandsPath = workspace.path("commands");
        const suiteArgsPath = workspace.path("suite-args");
        const result = spawnSync("bash", [scriptPath], {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            BASH_ENV: shellEnvPath,
            TMPDIR: workspace.dir,
            QA_TEST_REPO_ROOT: process.cwd(),
            QA_TEST_NODE_EXEC: resolveTestNodeExecPath(),
            QA_TEST_NODE_PRELOAD: preloadPath,
            QA_TEST_NODE_VERSION: versionPath,
            QA_TEST_PNPM_SPEC: pnpmSpecPath,
            QA_TEST_COMMANDS: commandsPath,
            QA_TEST_SUITE_ARGS: suiteArgsPath,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(commandsPath, "utf8").trim().split("\n")).toEqual(
          ["install", "build", "openclaw"].map((command) => command + ":" + expectedVersion),
        );
        const suiteArgs = fs.readFileSync(suiteArgsPath, "utf8").split("\0");
        const outputFlagIndex = suiteArgs.indexOf("--output-dir");
        expect(outputFlagIndex).toBeGreaterThan(-1);
        expect(
          resolveRepoRelativeOutputDir("/workspace/openclaw", suiteArgs[outputFlagIndex + 1]),
        ).toBe(`/workspace/openclaw/.artifacts/qa-e2e/multipass-node-${version}`);
        const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
          packageManager: string;
        };
        expect(fs.readFileSync(pnpmSpecPath, "utf8")).toBe(pkg.packageManager);
      },
    );
  });

  it("redacts persisted credentials while forwarding them to the executable script", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_ENV_VALUE);
    const { executableScript, persistedScript } = await captureGuestScriptsAtTransfer({
      outputDirName: "multipass-live-test",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(persistedScript).toContain("OPENAI_API_KEY='<redacted>'");
    expect(persistedScript).not.toContain(TEST_ENV_VALUE);
    expect(executableScript).toContain(`OPENAI_API_KEY='${TEST_ENV_VALUE}'`);
    expect(executableScript).not.toContain("<redacted>");
    expect(persistedScript).toContain("'--model' 'openai/gpt-5.6-luna'");
    expect(persistedScript).toContain("'--alt-model' 'openai/gpt-5.6-luna'");
    expect(persistedScript).toContain("'--fast'");
    expect(persistedScript).toContain("'--allow-failures'");
  });

  it("persists runtime, channel-driver, and plugin selections", async () => {
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-selection-test",
      runtimePair: ["openclaw", "codex"],
      channelDriver: "crabline",
      channelId: "telegram",
      enabledPluginIds: ["browser", "memory-core", "browser"],
    });

    expect(script).toContain("'--runtime-pair' 'openclaw,codex'");
    expect(script).toContain("'--channel-driver' 'crabline' '--channel' 'telegram'");
    expect(script).toContain("'--enable-plugin' 'browser' '--enable-plugin' 'memory-core'");
  });

  it("forwards supported live credential shapes only in redacted form", async () => {
    vi.stubEnv("OPENCLAW_LIVE_ANTHROPIC_KEYS", TEST_ENV_VALUE);
    vi.stubEnv("OPENCLAW_LIVE_CODEX_API_KEY", TEST_ENV_VALUE);
    vi.stubEnv("CODEX_API_KEY", TEST_ENV_VALUE);
    vi.stubEnv("OPENAI_API_KEY_1", TEST_ENV_VALUE);
    vi.stubEnv("GEMINI_API_KEY_2", TEST_ENV_VALUE);
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-env-test",
      providerMode: "live-frontier",
    });

    for (const key of [
      "OPENCLAW_LIVE_ANTHROPIC_KEYS",
      "OPENCLAW_LIVE_CODEX_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY_1",
      "GEMINI_API_KEY_2",
    ]) {
      expect(script).toContain(`${key}='<redacted>'`);
    }
    expect(script).not.toContain(TEST_ENV_VALUE);
  });

  it("omits stale CODEX_HOME values", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/does-not-exist-openclaw-codex-home");
    const script = await renderPersistedGuestScript({
      outputDirName: "multipass-stale-codex-home-test",
      providerMode: "live-frontier",
    });

    expect(script).not.toContain("CODEX_HOME=");
  });

  it("uses os.homedir() when HOME is unset for CODEX_HOME discovery", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-multipass-home-"));
    const fakeHome = path.join(tempRoot, "home");
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    vi.stubEnv("HOME", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    try {
      const script = await renderPersistedGuestScript({
        outputDirName: "multipass-home-test",
        providerMode: "live-frontier",
      });
      expect(script).toContain("CODEX_HOME='/workspace/openclaw-codex-home'");
      expect(script).not.toContain(fakeHome);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not leave a temp guest transfer script behind when multipass is missing", async () => {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    const before = new Set(fs.readdirSync(tempRoot));
    await renderPersistedGuestScript({
      outputDirName: "multipass-missing-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    const added = fs.readdirSync(tempRoot).filter((entry) => !before.has(entry));
    expect(added.filter((entry) => entry.includes("-qa-suite-"))).toStrictEqual([]);
  });

  it("preserves non-install multipass probe failures", async () => {
    runExecMock.mockRejectedValueOnce(
      Object.assign(new Error("multipassd is not running"), {
        code: "EACCES",
        stdout: "",
        stderr: "multipassd is not running",
      }),
    );
    const outputDir = path.join(
      process.cwd(),
      ".artifacts",
      "qa-e2e",
      "multipass-probe-error-test",
    );
    generatedPaths.push(outputDir);

    await expect(
      runQaMultipass({
        repoRoot: process.cwd(),
        outputDir,
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("Unable to verify Multipass availability: multipassd is not running.");
  });
});
