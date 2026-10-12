import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout: run,
}));
import { registerOpenShellWorkerCli } from "./worker-cli.js";

const worker = {
  model: {
    provider: "openai",
    id: "worker-model",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
    contextWindow: 8192,
    maxTokens: 1024,
  },
};
function config(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        openshell: {
          enabled: true,
          config: {
            gateway: "container",
            workspace: "workers",
            providers: ["broker"],
            from: "worker-image",
            worker,
          },
        },
      },
    },
  };
}
function invoke(cfg: OpenClawConfig, ...args: string[]) {
  const program = new Command().exitOverride();
  registerOpenShellWorkerCli(program, cfg);
  return program.parseAsync(["node", "openclaw", "openshell", "worker", ...args]);
}
afterEach(() => {
  vi.restoreAllMocks();
  run.mockReset();
  clearRuntimeConfigSnapshot();
});

describe("OpenShell standalone worker CLI", () => {
  it("binds the selected agent to a prepared canonical node workspace without widening command grants", async () => {
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const source: OpenClawConfig = {
          ...config(),
          agents: { entries: { main: { workspace: path.join(home, "gateway-workspace") } } },
          gateway: {
            nodes: {
              commands: {
                allow: [
                  "file.fetch",
                  "file.stat",
                  "file.write",
                  "file.create",
                  "dir.list",
                  "workspace.memory",
                  "workspace.skills",
                ],
              },
            },
          },
        };
        source.plugins!.entries!.openshell!.config = {
          ...source.plugins!.entries!.openshell!.config,
          worker: {
            ...worker,
            agentWorkspace: { agentId: "main", remoteRoot: "/agent/canonical" },
          },
        };
        await fs.writeFile(configPath, JSON.stringify(source));
        run.mockImplementation(async (argv: string[]) => ({
          code: 0,
          stdout: argv.includes("identity")
            ? JSON.stringify({ deviceId: "a".repeat(64) })
            : "/agent/canonical",
        }));
        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await invoke(
          source,
          "configure",
          "native-worker",
          "--worker-profile",
          "native",
          "--required",
          "--apply",
        );
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.plugins.entries["file-transfer"].config.workspaces.main).toEqual({
          nodeId: "a".repeat(64),
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
          await invoke(
            guarded,
            "configure",
            "native-worker",
            "--worker-profile",
            "native",
            "--apply",
          );
          expect(
            JSON.parse(await fs.readFile(configPath, "utf8")).plugins.entries["file-transfer"]
              .config.nodes,
          ).toEqual({ [selector]: existingPolicy });
        }
        const restrictions: Array<{ restrict: (cfg: OpenClawConfig) => void; error: RegExp }> = [
          {
            restrict: (cfg) => {
              cfg.plugins!.entries!["file-transfer"] = { enabled: false };
            },
            error: /existing plugin restriction/,
          },
          {
            restrict: (cfg) => {
              cfg.plugins!.deny = ["file-transfer"];
            },
            error: /existing plugin restriction/,
          },
          {
            restrict: (cfg) => {
              cfg.gateway!.nodes!.commands!.allow = ["file.fetch"];
            },
            error: /existing Gateway node-command grants/,
          },
          {
            restrict: (cfg) => {
              cfg.gateway!.nodes!.commands!.deny = ["file.write"];
            },
            error: /existing Gateway node-command grants/,
          },
          {
            restrict: (cfg) => {
              cfg.plugins!.entries!["file-transfer"] = {
                config: {
                  policyVersion: 2,
                  workspaces: { main: { nodeId: "different-node", remoteRoot: "/agent/other" } },
                },
              };
            },
            error: /different canonical workspace binding/,
          },
        ];
        restrictions.push({
          restrict: (cfg) => {
            const root = cfg.agents!.entries!.main!.workspace!;
            cfg.env = { vars: { OPEN_SHELL_TEST_WORKSPACE: root } };
            cfg.agents!.entries!.main!.workspace = "${OPEN_SHELL_TEST_WORKSPACE}";
            cfg.agents!.entries!.other = { workspace: root };
            cfg.agents!.ownership = "explicit";
          },
          error: /Another agent shares this Gateway workspace/,
        });
        for (const { restrict, error } of restrictions) {
          const restricted = structuredClone(source);
          restrict(restricted);
          const original = JSON.stringify(restricted);
          clearRuntimeConfigSnapshot();
          await fs.writeFile(configPath, original);
          const candidate = await readConfigFileSnapshotForWrite();
          expect(candidate.snapshot.valid, JSON.stringify(candidate.snapshot.issues)).toBe(true);
          await expect(
            invoke(
              restricted,
              "configure",
              "native-worker",
              "--worker-profile",
              "native",
              "--apply",
            ),
          ).rejects.toThrow(error);
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
        }
        expect(saved.plugins.entries["file-transfer"].config.nodes["a".repeat(64)]).toMatchObject({
          followSymlinks: false,
          allowWritePaths: expect.arrayContaining([
            "/agent/canonical/AGENTS.md",
            "/agent/canonical/SOUL.md",
          ]),
        });
      },
      {
        env: {
          OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../", import.meta.url)),
        },
      },
    );
  });
  it("creates through the configured OpenShell gateway without auto-importing host credentials", async () => {
    run.mockResolvedValue({ code: 0 });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await invoke(config(), "create", "native-worker");
    expect(run.mock.calls[0]?.[0]).toEqual([
      "openshell",
      "--gateway",
      "container",
      "--workspace",
      "workers",
      "sandbox",
      "create",
      "--name",
      "native-worker",
      "--from",
      "worker-image",
      "--detach",
      "--no-auto-providers",
      "--provider",
      "broker",
      "--",
      "sleep",
      "infinity",
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
        "openshell",
        "--gateway",
        "container",
        "--workspace",
        "workers",
        "sandbox",
        "provider",
        "attach",
        "native-worker",
        "broker",
        "--wait",
      ]);
      const [argv, options] = run.mock.calls[1]!;
      expect(argv.slice(5, 12)).toEqual([
        "sandbox",
        "exec",
        "native-worker",
        "--no-tty",
        "--no-login-shell",
        "--",
        "node",
      ]);
      expect(JSON.stringify(argv)).not.toContain("synthetic-single-use-target");
      const input = JSON.parse(options.input);
      expect(input.target).toBe("synthetic-single-use-target");
      expect(input.config.models.providers.openai.apiKey).toBe("${OPENAI_API_KEY}");
      expect(input.config.nodeHost.workerRuns).toEqual({ enabled: true, isolation: "none" });
      expect(input.config.models.providers.openai.models[0]).not.toHaveProperty("credentialEnv");
    });
  });

  it("joins sandbox stop after an uncertain exec failure and reports unconfirmed cleanup", async () => {
    run
      .mockResolvedValueOnce({ code: 0 })
      .mockRejectedValueOnce(new Error("connection dropped"))
      .mockResolvedValueOnce({ code: 0 });
    await expect(invoke(config(), "run", "native-worker")).rejects.toThrow("connection dropped");
    expect(run.mock.calls.at(-1)?.[0]).toEqual([
      "openshell",
      "--gateway",
      "container",
      "--workspace",
      "workers",
      "sandbox",
      "stop",
      "native-worker",
    ]);
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
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const source = {
          ...config(),
          env: { vars: { KEEP_ME: "kept" } },
          cloudWorkers: {
            desktop: true,
            profiles: { unrelated: { provider: "device", settings: { device: "other" } } },
          },
        };
        await fs.writeFile(configPath, JSON.stringify(source));
        const prepared = await readConfigFileSnapshotForWrite();
        expect(prepared.snapshot.valid, JSON.stringify(prepared.snapshot.issues)).toBe(true);
        run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ deviceId: "a".repeat(64) }) });
        vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await invoke(
          source,
          "configure",
          "native-worker",
          "--worker-profile",
          "native",
          "--device",
          "a".repeat(64),
          "--required",
        );
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(source);
        await invoke(
          source,
          "configure",
          "native-worker",
          "--worker-profile",
          "native",
          "--device",
          "a".repeat(64),
          "--required",
          "--apply",
        );
        const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(persisted.cloudWorkers).toMatchObject({
          desktop: true,
          requiredProfile: "native",
          profiles: {
            unrelated: source.cloudWorkers.profiles.unrelated,
            native: {
              provider: "device",
              settings: { device: "a".repeat(64), inference: "worker" },
            },
          },
        });
        expect(persisted.env).toEqual(source.env);
        expect(persisted.plugins.entries.openshell.config.worker).toEqual(worker);
        expect(persisted.models).toBeUndefined();
        await expect(
          invoke(
            source,
            "configure",
            "native-worker",
            "--worker-profile",
            "native",
            "--device",
            "different-device",
            "--apply",
          ),
        ).rejects.toThrow("does not match");
        expect(
          JSON.parse(await fs.readFile(configPath, "utf8")).cloudWorkers.profiles.native.settings
            .device,
        ).toBe("a".repeat(64));
      },
      {
        env: {
          OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../", import.meta.url)),
        },
      },
    );
  });
});
