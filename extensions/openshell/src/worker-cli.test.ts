import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout: run,
}));
import { registerOpenShellWorkerCli } from "./worker-cli.js";
import { createWorkerFixture } from "./worker.test-support.js";

const worker = createWorkerFixture();
function config(agentWorkspace?: { agentId: string; remoteRoot: string }): OpenClawConfig {
  const pluginConfig = {
    gateway: "container",
    workspace: "workers",
    providers: ["broker"],
    from: "worker-image",
    worker: createWorkerFixture(agentWorkspace),
  };
  return { plugins: { entries: { openshell: { enabled: true, config: pluginConfig } } } };
}
function invoke(cfg: OpenClawConfig, ...args: string[]) {
  const program = new Command().exitOverride();
  registerOpenShellWorkerCli(program, cfg);
  return program.parseAsync(["node", "openclaw", "openshell", "worker", ...args]);
}
const deviceId = "a".repeat(64);
const sandboxArgv = ["openshell", "--gateway", "container", "--workspace", "workers", "sandbox"];
function configure(cfg: OpenClawConfig, ...args: string[]) {
  return invoke(cfg, "configure", "native-worker", "--worker-profile", "native", ...args);
}
function withConfigHome(fn: (home: string, configPath: string) => Promise<void>) {
  return withTempHome((home) => fn(home, path.join(home, ".openclaw", "openclaw.json")), {
    env: {
      OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../", import.meta.url)),
    },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  run.mockReset();
  clearRuntimeConfigSnapshot();
});

describe("OpenShell standalone worker CLI", () => {
  it("binds the selected agent to a prepared canonical node workspace without widening command grants", async () => {
    await withConfigHome(async (home, configPath) => {
      const source: OpenClawConfig = {
        ...config({ agentId: "main", remoteRoot: "/agent/canonical" }),
        agents: { entries: { main: { workspace: path.join(home, "gateway-workspace") } } },
        gateway: {
          nodes: {
            commands: {
              allow:
                "file.fetch file.stat file.write file.create dir.list workspace.memory workspace.skills".split(
                  " ",
                ),
            },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(source));
      run.mockImplementation(async (argv: string[]) => ({
        code: 0,
        stdout: argv.includes("identity") ? JSON.stringify({ deviceId }) : "/agent/canonical",
      }));
      vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await configure(source, "--required", "--apply");
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(saved.plugins.entries["file-transfer"].config.workspaces.main).toEqual({
        nodeId: deviceId,
        remoteRoot: "/agent/canonical",
      });
      expect(saved.gateway.nodes.commands).toEqual(source.gateway!.nodes!.commands);
      expect(saved.agents).toEqual(source.agents);
      expect(saved.cloudWorkers.requiredProfile).toBe("native");
      const existingPolicy = { ask: "off", denyPaths: ["/**"], followSymlinks: false };
      for (const selector of ["*", "Operator-managed node"]) {
        const guarded = structuredClone(source);
        guarded.plugins!.entries!["file-transfer"] = {
          enabled: true,
          config: { policyVersion: 2, nodes: { [selector]: existingPolicy } },
        };
        clearRuntimeConfigSnapshot();
        await fs.writeFile(configPath, JSON.stringify(guarded));
        await configure(guarded, "--apply");
        expect(
          JSON.parse(await fs.readFile(configPath, "utf8")).plugins.entries["file-transfer"].config
            .nodes,
        ).toEqual({ [selector]: existingPolicy });
      }
      const restrictions: Array<[(cfg: OpenClawConfig) => void, RegExp]> = [
        [
          (cfg) => Object.assign(cfg.plugins!.entries!, { "file-transfer": { enabled: false } }),
          /existing plugin restriction/,
        ],
        [
          (cfg) => Object.assign(cfg.plugins!, { deny: ["file-transfer"] }),
          /existing plugin restriction/,
        ],
        [
          (cfg) => Object.assign(cfg.gateway!.nodes!.commands!, { allow: ["file.fetch"] }),
          /existing Gateway node-command grants/,
        ],
        [
          (cfg) => Object.assign(cfg.gateway!.nodes!.commands!, { deny: ["file.write"] }),
          /existing Gateway node-command grants/,
        ],
        [
          (cfg) => {
            cfg.plugins!.entries!["file-transfer"] = {
              config: {
                policyVersion: 2,
                workspaces: { main: { nodeId: "different-node", remoteRoot: "/agent/other" } },
              },
            };
          },
          /different canonical workspace binding/,
        ],
        [
          (cfg) => {
            const root = cfg.agents!.entries!.main!.workspace!;
            cfg.env = { vars: { OPEN_SHELL_TEST_WORKSPACE: root } };
            cfg.agents!.entries!.main!.workspace = "${OPEN_SHELL_TEST_WORKSPACE}";
            cfg.agents!.entries!.other = { workspace: root };
            cfg.agents!.ownership = "explicit";
          },
          /Another agent shares this Gateway workspace/,
        ],
      ];
      for (const [restrict, error] of restrictions) {
        const restricted = structuredClone(source);
        restrict(restricted);
        const original = JSON.stringify(restricted);
        clearRuntimeConfigSnapshot();
        await fs.writeFile(configPath, original);
        await expect(configure(restricted, "--apply")).rejects.toThrow(error);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
      }
      expect(saved.plugins.entries["file-transfer"].config.nodes[deviceId]).toMatchObject({
        followSymlinks: false,
        allowWritePaths: expect.arrayContaining([
          "/agent/canonical/AGENTS.md",
          "/agent/canonical/SOUL.md",
        ]),
      });
    });
  });
  it("creates through the configured OpenShell gateway without auto-importing host credentials", async () => {
    run.mockResolvedValue({ code: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await invoke(config(), "create", "native-worker");
    expect(run.mock.calls[0]?.[0]).toEqual([
      ...sandboxArgv,
      ..."create --name native-worker --from worker-image --detach --no-auto-providers --provider broker -- sleep infinity".split(
        " ",
      ),
    ]);
    await expect(invoke({}, "create", "native-worker")).rejects.toThrow("at least one existing");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("withholds node launch on failed broker readiness, then sends pairing only through stdin", async () => {
    await withTempHome(async (home) => {
      const target = path.join(home, "pairing");
      await fs.writeFile(target, "synthetic-single-use-target", { mode: 0o600 });
      run.mockResolvedValueOnce({ code: 1 });
      await expect(
        invoke(config(), "run", "native-worker", "--target-file", target),
      ).rejects.toThrow("No node was started");
      expect(run).toHaveBeenCalledTimes(1);
      run.mockReset().mockResolvedValue({ code: 0 });
      await invoke(config(), "run", "native-worker", "--target-file", target);
      expect(run.mock.calls[0]?.[0]).toEqual([
        ...sandboxArgv,
        ..."provider attach native-worker broker --wait".split(" "),
      ]);
      const [argv, options] = run.mock.calls[1]!;
      const command = argv.slice(argv.indexOf("sandbox"));
      const separator = command.indexOf("--");
      expect(command.slice(0, 3)).toEqual(["sandbox", "exec", "native-worker"]);
      expect(command.slice(3, separator)).toEqual(
        expect.arrayContaining(["--no-tty", "--no-login-shell"]),
      );
      expect(command.slice(separator + 1, separator + 3)).toEqual(["node", "-e"]);
      expect(JSON.stringify(argv)).not.toContain("synthetic-single-use-target");
      expect(JSON.parse(options.input).target).toBe("synthetic-single-use-target");
    });
  });

  it("joins sandbox stop after an uncertain exec failure and reports unconfirmed cleanup", async () => {
    run
      .mockResolvedValueOnce({ code: 0 })
      .mockRejectedValueOnce(new Error("connection dropped"))
      .mockResolvedValueOnce({ code: 0 });
    await expect(invoke(config(), "run", "native-worker")).rejects.toThrow("connection dropped");
    expect(run.mock.calls.at(-1)?.[0]).toEqual([...sandboxArgv, "stop", "native-worker"]);
    run
      .mockReset()
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ code: 0 })
      .mockResolvedValueOnce({ code: 1 });
    await expect(invoke(config(), "run", "native-worker")).rejects.toThrow(
      "stop was not confirmed",
    );
  });

  it("previews without writes and persists only the canonical profile while preserving unrelated config", async () => {
    await withConfigHome(async (_home, configPath) => {
      const source = {
        ...config(),
        env: { vars: { KEEP_ME: "kept" } },
        cloudWorkers: {
          desktop: true,
          profiles: { unrelated: { provider: "device", settings: { device: "other" } } },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(source));
      run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ deviceId }) });
      vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await configure(source, "--device", deviceId, "--required");
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(source);
      await configure(source, "--device", deviceId, "--required", "--apply");
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(persisted.cloudWorkers).toMatchObject({
        desktop: true,
        requiredProfile: "native",
        profiles: {
          unrelated: source.cloudWorkers.profiles.unrelated,
          native: {
            provider: "device",
            settings: { device: deviceId, inference: "worker" },
          },
        },
      });
      expect(persisted.env).toEqual(source.env);
      expect(persisted.plugins.entries.openshell.config.worker).toEqual(worker);
      expect(persisted.models).toBeUndefined();
      await expect(configure(source, "--device", "different-device", "--apply")).rejects.toThrow(
        "does not match",
      );
      expect(
        JSON.parse(await fs.readFile(configPath, "utf8")).cloudWorkers.profiles.native.settings
          .device,
      ).toBe(deviceId);
    });
  });
});
