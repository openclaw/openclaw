import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { killProcessTree, resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import * as managedBinary from "./app-server/managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { closedStdinDoctorEntrypoint } from "./doctor-closed-stdin-entrypoint.test-support.js";
import {
  CODEX_MANAGED_APP_SERVER_CHECK_ID,
  registerCodexManagedAppServerDoctorChecks,
} from "./doctor.js";

const closedStdinDoctor = resolveRuntimeWorkerUrl(closedStdinDoctorEntrypoint);

function config(appServer: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol" },
        models: {
          "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
        },
      },
    },
    plugins: { entries: { codex: { enabled: true, config: { appServer } } } },
  };
}

function context(cfg = config(), mode: "lint" | "fix" = "lint") {
  return {
    mode,
    runtime: {} as never,
    cfg,
    env: mode === "fix" ? { OPENCLAW_UPDATE_POST_CORE: "1" } : {},
  };
}

function managedDeps(version = CODEX_APP_SERVER_VERSION) {
  vi.spyOn(managedBinary, "isManagedCodexDesktopCommand").mockImplementation((command) =>
    command.startsWith("/Applications/"),
  );
  const resolveNativeCommand = vi
    .spyOn(managedBinary, "resolveManagedCodexNativeCommand")
    .mockReturnValue("/candidate/plugin/codex-native");
  return {
    resolveStartOptions: vi
      .spyOn(managedBinary, "resolveManagedCodexAppServerStartOptions")
      .mockImplementation(async (start) => ({
        ...start,
        command:
          start.managedCommandOrder === "desktop-first"
            ? "/Applications/ChatGPT.app/Contents/Resources/codex"
            : "/candidate/plugin/codex",
        commandSource: "resolved-managed" as const,
      })),
    resolveNativeCommand,
    runVersionCommand: vi
      .spyOn(managedBinary, "runCodexVersionCommand")
      .mockResolvedValue(`codex-cli ${version}\n`),
  };
}

function registry() {
  let check: HealthCheck | undefined;
  return {
    pluginRoot: "/candidate/plugin",
    getHealthCheck: () => check,
    registerHealthCheck: vi.fn((value: HealthCheck) => {
      check = value;
    }),
  };
}

function createCheck() {
  const host = registry();
  registerCodexManagedAppServerDoctorChecks(host);
  const check = host.getHealthCheck();
  if (!check) {
    throw new Error("Codex managed health check was not registered");
  }
  return check;
}

function nativeCheck(command: string) {
  const deps = managedDeps();
  deps.runVersionCommand.mockRestore();
  deps.resolveNativeCommand.mockReturnValue(command);
  return createCheck();
}

function expectFinding(findings: unknown, expected: Record<string, unknown>) {
  expect(findings).toEqual([expect.objectContaining(expected)]);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
it.skipIf(process.platform === "win32")(
  "returns successful JSON when a version binary closes stdin immediately",
  async () => {
    const root = tempDirs.make("openclaw-codex-closed-stdin-");
    const command = path.join(root, "codex");
    const packageRoot = path.join(root, "node_modules", "@openai", "codex");
    const launcher = path.join(packageRoot, "bin", "codex.js");
    const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
    const native = path.join(packageRoot, "vendor", triple, "bin", "codex");
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    await fs.mkdir(path.dirname(native), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"@openai/codex"}');
    await fs.writeFile(launcher, "", { mode: 0o755 });
    await fs.symlink(command, native);
    await fs.writeFile(
      command,
      `#!${process.execPath}
const fs = require("node:fs");
const stdin = fs.fstatSync(0);
fs.closeSync(0);
// Reject an unnecessary input transport deterministically instead of racing its empty write.
if (stdin.isSocket() || stdin.isFIFO()) process.exit(1);
fs.writeSync(1, "codex-cli ${CODEX_APP_SERVER_VERSION}\\n");
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(closedStdinDoctor), command, JSON.stringify(config())],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: path.dirname(process.execPath),
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result, result.stderr || result.stdout).toMatchObject({
      signal: null,
      status: 0,
    });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      findings: [],
      checksRun: 1,
      checksSkipped: 0,
    });
  },
);
it("reports an incompatible passive catalog executable without Codex routes", async () => {
  const cfg = config({ homeScope: "user" });
  cfg.agents = { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } };
  const deps = managedDeps();
  deps.runVersionCommand.mockRejectedValueOnce(
    Object.assign(new Error("spawn failed"), {
      code: "Unknown system error -86",
      errno: -86,
      syscall: "spawn",
    }),
  );
  expectFinding(await createCheck().detect(context(cfg)), {
    severity: "warning",
    path: "/candidate/plugin/codex-native",
    message: expect.stringContaining(
      "Codex catalog updater cannot run: /candidate/plugin/codex-native is not runnable on this CPU",
    ),
  });
  expect(deps.resolveStartOptions).toHaveBeenCalledWith(
    expect.objectContaining({ managedCommandOrder: "package-only" }),
    { pluginRoot: "/candidate/plugin", preferInstalled: false },
  );
});

it("reports a real missing executable during update finalization", async () => {
  const directory = tempDirs.make("openclaw-codex-missing-");
  const command = path.join(directory, "missing-codex");
  expectFinding(await nativeCheck(command).detect(context(config(), "fix")), {
    severity: "warning",
    path: command,
    message: `Codex catalog updater cannot run: ${command} or its working directory was not found. Repair the executable or working directory and restart the Gateway.`,
  });
});

it("registers once in each host registry", () => {
  for (let index = 0; index < 2; index++) {
    const host = registry();
    registerCodexManagedAppServerDoctorChecks(host);
    registerCodexManagedAppServerDoctorChecks(host);
    expect(host.registerHealthCheck).toHaveBeenCalledOnce();
    expect(host.getHealthCheck()?.id).toBe(CODEX_MANAGED_APP_SERVER_CHECK_ID);
  }
});

it.skipIf(process.platform === "win32").each([
  {
    scenario: "orphaned output pipes",
    detached: true,
    source: (pidPath: string) => `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const orphan = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], {
  detached: true,
  stdio: ["ignore", 1, 2],
});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(orphan.pid));
orphan.unref();
console.log("codex-cli ${CODEX_APP_SERVER_VERSION}");
`,
  },
  {
    scenario: "ignored SIGTERM",
    detached: false,
    source: (
      pidPath: string,
    ) => `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  },
])(
  "bounds a version probe with $scenario",
  async ({ source, detached }) => {
    const directory = tempDirs.make("openclaw-codex-probe-");
    const command = path.join(directory, "codex");
    const pidPath = path.join(directory, "probe.pid");
    try {
      await fs.writeFile(command, `#!${process.execPath}\n${source(pidPath)}`, { mode: 0o755 });
      const check = nativeCheck(command);
      const startedAt = performance.now();
      const findings = await check.detect(context(config(), detached ? "fix" : "lint"));
      expectFinding(findings, {
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        ...(detached
          ? {
              severity: "warning",
              message: expect.stringContaining("version check failed:"),
              fixHint: expect.stringContaining("after restart"),
            }
          : {
              path: command,
              message:
                "Managed Codex app-server version check failed: Version check timed out after 5000 ms",
              requirement: `Codex ${CODEX_APP_SERVER_VERSION} must report its version within 5000 ms`,
            }),
      });
      if (detached) {
        expect(performance.now() - startedAt).toBeLessThan(7_000);
      } else {
        const pid = Number(await fs.readFile(pidPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    } finally {
      const pid = Number(await fs.readFile(pidPath, "utf8").catch(() => ""));
      if (pid > 0) {
        killProcessTree(pid, { force: true, detached });
      }
    }
  },
  15_000,
);

it.each([
  ["missing launcher", "Managed Codex app-server could not be resolved: managed launcher missing"],
  [
    "absent native artifact",
    "Managed Codex app-server resolved a launcher without a native artifact.",
  ],
])("reports a %s before execution", async (scenario, message) => {
  const deps = managedDeps();
  if (scenario === "missing launcher") {
    deps.resolveStartOptions.mockRejectedValueOnce(new Error("managed launcher missing"));
  } else {
    deps.resolveNativeCommand.mockReturnValueOnce(undefined);
  }
  expectFinding(await createCheck().detect(context()), {
    checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
    message,
    ...(scenario === "absent native artifact" ? { path: "/candidate/plugin/codex" } : {}),
  });
  expect(deps.runVersionCommand).not.toHaveBeenCalled();
});

it.each([
  ["custom command", { command: "/operator/codex" }],
  ["unix transport", { transport: "unix", url: "unix:///tmp/codex.sock", homeScope: "user" }],
])("does not probe a %s", async (_label, appServer) => {
  const deps = managedDeps();
  await expect(createCheck().detect(context(config(appServer)))).resolves.toEqual([]);
  expect(deps.resolveStartOptions).not.toHaveBeenCalled();
  expect(deps.runVersionCommand).not.toHaveBeenCalled();
});

it("ignores managed commands for agents whose effective runtime is not Codex", async () => {
  const agentDir = tempDirs.make("openclaw-codex-doctor-agent-");
  const home = path.join(agentDir, "codex-home");
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(home, "config.toml"),
    '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
  );
  const cfg = config();
  cfg.agents = {
    ...cfg.agents,
    entries: {
      desktop: { agentDir },
      openclaw: {
        model: "anthropic/claude-opus-4-7",
        models: {
          "anthropic/claude-opus-4-7": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
  };
  const deps = managedDeps();
  await expect(createCheck().detect(context(cfg))).resolves.toEqual([]);
  expect(deps.resolveStartOptions).toHaveBeenCalledTimes(2);
  expect(deps.runVersionCommand.mock.calls).toEqual([["/candidate/plugin/codex-native", {}]]);
});

it("still validates a package fallback selected after desktop-first resolution", async () => {
  const deps = managedDeps("0.146.0");
  deps.resolveStartOptions.mockImplementationOnce(async (start) => ({
    ...start,
    command: "/candidate/plugin/codex",
    commandSource: "resolved-managed" as const,
  }));
  expectFinding(await createCheck().detect(context(config({ homeScope: "user" }))), {
    checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
    severity: "error",
    path: "/candidate/plugin/codex-native",
    message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
  });
  expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native", {});
});
