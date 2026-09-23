import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import {
  CODEX_MANAGED_APP_SERVER_CHECK_ID,
  registerCodexManagedAppServerDoctorChecks,
} from "./doctor.js";

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
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              args: [
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "model_context_window=1000000",
                "-c",
                "model_auto_compact_token_limit=700000",
                "-c",
                "model_auto_compact_token_limit_scope=total",
              ],
              ...appServer,
            },
          },
        },
      },
    },
  };
}

function context(cfg: OpenClawConfig) {
  return {
    mode: "lint" as const,
    runtime: {} as never,
    cfg,
    env: {} as NodeJS.ProcessEnv,
  };
}

function managedDeps(version = CODEX_APP_SERVER_VERSION) {
  const resolveNativeCommand = vi.fn(
    (_command: string): string | undefined => "/candidate/plugin/codex-native",
  );
  return {
    resolveStartOptions: vi.fn(async (start) => ({
      ...start,
      command:
        start.managedCommandOrder === "desktop-first"
          ? "/Applications/ChatGPT.app/Contents/Resources/codex"
          : "/candidate/plugin/codex",
      commandSource: "resolved-managed" as const,
    })),
    isDesktopCommand: vi.fn((command: string) => command.startsWith("/Applications/")),
    resolveNativeCommand,
    runVersionCommand: vi.fn(async () => ({ stdout: `codex-cli ${version}\n`, stderr: "" })),
  };
}

function createCheck(deps: Parameters<typeof registerCodexManagedAppServerDoctorChecks>[1]) {
  let check: HealthCheck | undefined;
  registerCodexManagedAppServerDoctorChecks(
    {
      pluginRoot: "/candidate/plugin",
      getHealthCheck: () => check,
      registerHealthCheck(value) {
        check = value;
      },
    },
    deps,
  );
  if (!check) {
    throw new Error("Codex managed health check was not registered");
  }
  return check;
}

describe("managed Codex doctor check", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each([
    { code: "Unknown system error -86", errno: -86, syscall: "spawn" },
    { code: "Unknown system error -86" },
  ])(
    "reports an incompatible passive catalog executable without Codex routes: %j",
    async (failure) => {
      const cfg = config({ homeScope: "user" });
      cfg.agents = { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } };
      const deps = managedDeps();
      deps.runVersionCommand.mockRejectedValueOnce(
        Object.assign(new Error("spawn failed"), failure),
      );
      await expect(createCheck(deps).detect(context(cfg))).resolves.toEqual([
        expect.objectContaining({
          severity: "warning",
          path: "/candidate/plugin/codex-native",
          message: expect.stringContaining(
            "Codex catalog updater cannot run: /candidate/plugin/codex-native is not runnable on this CPU",
          ),
        }),
      ]);
      expect(deps.resolveStartOptions).toHaveBeenCalledWith(
        expect.objectContaining({ managedCommandOrder: "package-only" }),
        { pluginRoot: "/candidate/plugin" },
      );
    },
  );

  it.each(["active", "passive", "updating"])(
    "reports a real missing executable for %s use",
    async (scope) => {
      const directory = tempDirs.make("openclaw-codex-missing-");
      const command = path.join(directory, "missing-codex");
      const check = createCheck({
        ...managedDeps(),
        resolveNativeCommand: () => command,
        runVersionCommand: undefined,
      });
      const cfg = config();
      if (scope === "passive") {
        cfg.agents = { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } };
      }
      const ctx = context(cfg);
      await expect(
        check.detect(
          scope === "updating"
            ? {
                ...ctx,
                mode: "fix",
                env: { OPENCLAW_UPDATE_POST_CORE: "1" },
              }
            : ctx,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          severity: scope === "active" ? "error" : "warning",
          path: command,
          message: `Codex catalog updater cannot run: ${command} or its working directory was not found. Repair the executable or working directory and restart the Gateway.`,
        }),
      ]);
    },
  );
  it("registers once in each host registry", () => {
    for (let index = 0; index < 2; index++) {
      let check: HealthCheck | undefined;
      const host = {
        pluginRoot: "/candidate/plugin",
        getHealthCheck: () => check,
        registerHealthCheck: vi.fn((value: HealthCheck) => {
          check = value;
        }),
      };

      registerCodexManagedAppServerDoctorChecks(host);
      registerCodexManagedAppServerDoctorChecks(host);

      expect(host.registerHealthCheck).toHaveBeenCalledOnce();
      expect(check?.id).toBe(CODEX_MANAGED_APP_SERVER_CHECK_ID);
    }
  });

  it("accepts the exact pinned native binary without changing explicit long-context config", async () => {
    const cfg = config();
    const before = structuredClone(cfg);
    const deps = managedDeps();
    const check = createCheck(deps);

    await expect(check.detect(context(cfg))).resolves.toEqual([]);
    expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native");
    expect(cfg).toEqual(before);
  });

  it("reports the exact expected and detected versions", async () => {
    const deps = managedDeps("0.146.0");
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        severity: "error",
        path: "/candidate/plugin/codex-native",
        message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
      }),
    ]);
  });

  it.each(["failed", "mismatched"])(
    "reports a %s version probe as a warning during update finalization",
    async (failure) => {
      const deps = managedDeps("0.146.0");
      if (failure === "failed") {
        deps.runVersionCommand.mockRejectedValueOnce(new Error("probe failed"));
      }
      const check = createCheck(deps);

      await expect(
        check.detect({
          ...context(config()),
          mode: "fix",
          env: { OPENCLAW_UPDATE_POST_CORE: "1" },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
          severity: "warning",
          fixHint: expect.stringContaining("after restart"),
        }),
      ]);
    },
  );

  it("keeps an explicitly selected candidate lint check strict during an update", async () => {
    const check = createCheck(managedDeps("0.146.0"));

    await expect(
      check.detect({
        ...context(config()),
        env: { OPENCLAW_UPDATE_POST_CORE: "1" },
      }),
    ).resolves.toEqual([expect.objectContaining({ severity: "error" })]);
  });

  it.skipIf(process.platform === "win32")(
    "bounds a successful probe whose detached descendant retains its output pipes",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-orphan-"));
      const pidPath = path.join(directory, "orphan.pid");
      try {
        const command = path.join(directory, "codex");
        await fs.writeFile(
          command,
          `#!${process.execPath}
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const orphan = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], {
  detached: true,
  stdio: ["ignore", 1, 2],
});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(orphan.pid));
orphan.unref();
console.log("codex-cli ${CODEX_APP_SERVER_VERSION}");
`,
          { mode: 0o755 },
        );
        const check = createCheck({
          ...managedDeps(),
          resolveNativeCommand: () => command,
          runVersionCommand: undefined,
        });
        const startedAt = performance.now();
        const findings = await check.detect({
          ...context(config()),
          mode: "fix",
          env: { OPENCLAW_UPDATE_POST_CORE: "1" },
        });

        expect(performance.now() - startedAt).toBeLessThan(7_000);
        expect(findings).toEqual([
          expect.objectContaining({
            checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
            severity: "warning",
            message: expect.stringContaining("version check failed:"),
          }),
        ]);
      } finally {
        const orphanPid = Number(await fs.readFile(pidPath, "utf8").catch(() => ""));
        if (orphanPid > 0) {
          killProcessTree(orphanPid, { force: true, detached: true });
        }
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("reports a missing managed launcher before execution", async () => {
    const deps = managedDeps();
    deps.resolveStartOptions.mockRejectedValueOnce(new Error("managed launcher missing"));
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        message: "Managed Codex app-server could not be resolved: managed launcher missing",
      }),
    ]);
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it("reports a launcher whose platform-native artifact is absent", async () => {
    const deps = managedDeps();
    deps.resolveNativeCommand.mockReturnValueOnce(undefined);
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        path: "/candidate/plugin/codex",
        message: "Managed Codex app-server resolved a launcher without a native artifact.",
      }),
    ]);
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "bounds a native version probe that ignores SIGTERM",
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-version-"));
      const pidPath = path.join(directory, "probe.pid");
      try {
        const command = path.join(directory, "codex");
        await fs.writeFile(
          command,
          `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
          { mode: 0o755 },
        );
        const check = createCheck({
          ...managedDeps(),
          resolveNativeCommand: () => command,
          runVersionCommand: undefined,
        });
        const findings = await check.detect(context(config()));

        expect(findings).toEqual([
          expect.objectContaining({
            checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
            path: command,
            message:
              "Managed Codex app-server version check failed: Version probe timed out after 5000 ms",
            requirement: `Codex ${CODEX_APP_SERVER_VERSION} must report its version within 5000 ms`,
          }),
        ]);
        const probePid = Number(await fs.readFile(pidPath, "utf8"));
        expect(() => process.kill(probePid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      } finally {
        const probePid = Number(await fs.readFile(pidPath, "utf8").catch(() => ""));
        if (probePid > 0) {
          killProcessTree(probePid, { force: true });
        }
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each([
    ["custom command", { command: "/operator/codex" }],
    ["websocket transport", { transport: "websocket", url: "ws://127.0.0.1:4500" }],
    ["unix transport", { transport: "unix", url: "unix:///tmp/codex.sock", homeScope: "user" }],
  ])("does not probe a %s", async (_label, appServer) => {
    const deps = managedDeps();
    const check = createCheck(deps);

    await expect(check.detect(context(config(appServer)))).resolves.toEqual([]);
    expect(deps.resolveStartOptions).not.toHaveBeenCalled();
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it("checks the passive catalog package without enforcing its pin on a desktop-owned command", async () => {
    const deps = managedDeps("0.146.0");
    const check = createCheck(deps);

    await expect(check.detect(context(config({ homeScope: "user" })))).resolves.toEqual([
      expect.objectContaining({ path: "/candidate/plugin/codex-native", severity: "error" }),
    ]);
    expect(deps.resolveStartOptions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ managedCommandOrder: "desktop-first" }),
      { pluginRoot: "/candidate/plugin" },
    );
    expect(deps.resolveStartOptions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ managedCommandOrder: "package-only" }),
      { pluginRoot: "/candidate/plugin" },
    );
    expect(deps.resolveNativeCommand).toHaveBeenCalledExactlyOnceWith("/candidate/plugin/codex");
    expect(deps.runVersionCommand).toHaveBeenCalledExactlyOnceWith(
      "/candidate/plugin/codex-native",
    );
  });

  it("uses persisted per-agent Computer Use state before selecting the managed command", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-agent-"));
    try {
      await fs.mkdir(path.join(agentDir, "codex-home"));
      await fs.writeFile(
        path.join(agentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const cfg = config();
      cfg.agents = {
        ...cfg.agents,
        list: [{ id: "main", agentDir }],
      };
      const deps = managedDeps();
      const check = createCheck(deps);

      await expect(check.detect(context(cfg))).resolves.toEqual([]);
      expect(deps.resolveStartOptions).toHaveBeenCalledWith(
        expect.objectContaining({ managedCommandOrder: "desktop-first" }),
        { pluginRoot: "/candidate/plugin" },
      );
      expect(deps.resolveNativeCommand).toHaveBeenCalledExactlyOnceWith("/candidate/plugin/codex");
      expect(deps.runVersionCommand).toHaveBeenCalledExactlyOnceWith(
        "/candidate/plugin/codex-native",
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("still validates the package when any configured agent can select it", async () => {
    const desktopAgentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-doctor-desktop-agent-"),
    );
    const packageAgentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-doctor-package-agent-"),
    );
    try {
      await fs.mkdir(path.join(desktopAgentDir, "codex-home"));
      await fs.writeFile(
        path.join(desktopAgentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const cfg = config();
      cfg.agents = {
        ...cfg.agents,
        list: [
          { id: "desktop", agentDir: desktopAgentDir },
          { id: "package", agentDir: packageAgentDir },
        ],
      };
      const deps = managedDeps("0.146.0");
      const check = createCheck(deps);

      await expect(check.detect(context(cfg))).resolves.toEqual([
        expect.objectContaining({
          checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
          message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
        }),
      ]);
      expect(deps.resolveStartOptions).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ managedCommandOrder: "desktop-first" }),
        { pluginRoot: "/candidate/plugin" },
      );
      expect(deps.resolveStartOptions).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({ managedCommandOrder: expect.anything() }),
        { pluginRoot: "/candidate/plugin" },
      );
      expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native");
    } finally {
      await Promise.all(
        [desktopAgentDir, packageAgentDir].map((agentDir) =>
          fs.rm(agentDir, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("ignores managed commands for agents whose effective runtime is not Codex", async () => {
    const desktopAgentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-doctor-desktop-agent-"),
    );
    try {
      await fs.mkdir(path.join(desktopAgentDir, "codex-home"));
      await fs.writeFile(
        path.join(desktopAgentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const cfg = config();
      cfg.agents = {
        ...cfg.agents,
        list: [
          { id: "desktop", agentDir: desktopAgentDir },
          {
            id: "openclaw",
            model: "anthropic/claude-opus-4-7",
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      };
      const deps = managedDeps();
      const check = createCheck(deps);

      await expect(check.detect(context(cfg))).resolves.toEqual([]);
      expect(deps.resolveStartOptions).toHaveBeenCalledTimes(2);
      expect(deps.runVersionCommand).toHaveBeenCalledExactlyOnceWith(
        "/candidate/plugin/codex-native",
      );
    } finally {
      await fs.rm(desktopAgentDir, { recursive: true, force: true });
    }
  });

  it("still validates a package fallback selected after desktop-first resolution", async () => {
    const deps = managedDeps("0.146.0");
    deps.resolveStartOptions.mockImplementationOnce(async (start) => ({
      ...start,
      command: "/candidate/plugin/codex",
      commandSource: "resolved-managed" as const,
    }));
    const check = createCheck(deps);

    await expect(check.detect(context(config({ homeScope: "user" })))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
      }),
    ]);
    expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native");
  });
});
