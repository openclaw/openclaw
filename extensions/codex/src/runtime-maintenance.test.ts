import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { HealthCheckContext, OpenClawConfig } from "openclaw/plugin-sdk/health";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { commandProcessCleanup } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import type { updateCodexDesktopApp } from "./app-server/desktop-app-update.js";
import type { probeCodexDesktopRuntime } from "./app-server/desktop-runtime-probe.js";
import * as probes from "./app-server/desktop-runtime-probe.js";
import * as binaries from "./app-server/managed-binary.js";
import * as cliUpdates from "./app-server/managed-cli-update.js";
import { createCodexRuntimeMaintenanceService } from "./runtime-maintenance-service.js";
import { createCodexRuntimeMaintenanceChecks } from "./runtime-maintenance.js";

describe("selected Codex runtime maintenance", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function fixture() {
    const root = tempDirs.make("codex-maintenance-");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
        },
        entries: { main: { agentDir: path.join(root, "agent") } },
      },
      plugins: {
        entries: { codex: { enabled: true, config: { computerUse: { enabled: true } } } },
      },
    };
    const controller = new AbortController();
    const probe = vi.fn<typeof probeCodexDesktopRuntime>(async () => undefined);
    const resolveCommand = vi.fn(async (start: CodexAppServerStartOptions) => ({
      ...start,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const updateApp = vi.fn<typeof updateCodexDesktopApp>(async (params) => {
      await params.validateCandidate({
        appBundlePath: "/staged/ChatGPT.app",
        appServerCommandPath: "/staged/ChatGPT.app/Contents/Resources/codex",
      });
      return {
        status: "updated",
        oldVersion: "1",
        newVersion: "2",
        appBundlePath: params.appBundlePath,
        backupPath: "/rollback/ChatGPT.app",
      };
    });
    const operation = {
      operation: "update" as const,
      pluginRoot: "/selected/codex",
      signal: controller.signal,
      assertCurrent: vi.fn(),
    };
    const deps = { platform: "darwin" as const, resolveCommand, updateApp, probe };
    const ctx: HealthCheckContext = {
      cfg,
      mode: "fix",
      runtime: {} as never,
      env: { OPENCLAW_STATE_DIR: root },
    };
    const check = createCodexRuntimeMaintenanceChecks(operation, deps)[0];
    if (!check) {
      throw new Error("Expected a registered Codex runtime maintenance check");
    }
    return { cfg, ctx, check, deps, operation, controller, root };
  }

  function automaticFixture() {
    vi.useFakeTimers();
    const f = fixture();
    f.cfg.plugins!.entries!.codex!.config = { appServer: { homeScope: "agent" } };
    vi.spyOn(binaries, "resolveManagedCodexAppServerStartOptions").mockImplementation(
      async (start) => ({
        ...start,
        command: "/managed/cli/bin/codex.js",
        commandSource: "resolved-managed",
      }),
    );
    vi.spyOn(probes, "probeCodexDesktopRuntime").mockImplementation(f.deps.probe);
    const ctx: OpenClawPluginServiceContextV2 = {
      config: f.cfg,
      stateDir: f.root,
      scheduler: createTestPluginServiceScheduler(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      serviceHealth: { clearFailure: vi.fn(), reportFailure: vi.fn() },
    };
    const service = createCodexRuntimeMaintenanceService({
      pluginRoot: f.root,
      getConfig: () => f.cfg,
    });
    return { ...f, ctx, service };
  }

  it("automatically selects subsequent stable CLI releases in the same plugin service and backs off failures", async () => {
    const f = automaticFixture();
    let version = "99.1.0";
    const update = vi
      .spyOn(cliUpdates, "updateCodexManagedCli")
      .mockImplementation(async (params) => {
        await params.validateCandidate(`/managed/${version}/bin/codex.js`, version);
        params.assertCurrent();
        return { status: "updated", version };
      });
    try {
      await f.service.start(f.ctx);
      expect(update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(update).toHaveBeenCalledOnce();
      expect(f.ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("99.1.0"));
      version = "99.2.0";
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(update).toHaveBeenCalledTimes(2);
      expect(f.ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("99.2.0"));
      update.mockRejectedValueOnce(new Error("synthetic incompatible release"));
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(f.ctx.serviceHealth!.reportFailure).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
      expect(update).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(update).toHaveBeenCalledTimes(4);
      await f.service.stop?.(f.ctx);
      await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
      expect(update).toHaveBeenCalledTimes(4);
    } finally {
      await f.service.stop?.(f.ctx);
    }
  });

  it("reports a committed automatic selection even when its cleanup needs attention", async () => {
    const f = automaticFixture();
    vi.spyOn(cliUpdates, "updateCodexManagedCli").mockResolvedValue({
      status: "updated",
      version: "99.3.0",
      warnings: ["Selected runtime, but staging cleanup failed"],
    });
    try {
      await f.service.start(f.ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("selected: 99.3.0"));
      expect(f.ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("staging cleanup failed"),
      );
      expect(f.ctx.logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("retained the working selection"),
      );
      expect(f.ctx.serviceHealth!.reportFailure).toHaveBeenCalledOnce();
    } finally {
      await f.service.stop?.(f.ctx);
    }
  });

  it.each([
    ["OPENCLAW_NO_AUTO_UPDATE", "1"],
    ["OPENCLAW_NO_AUTO_UPDATE", "true"],
    ["OPENCLAW_NO_AUTO_UPDATE", "yes"],
    ["OPENCLAW_NO_AUTO_UPDATE", "on"],
    ["OPENCLAW_NO_AUTO_UPDATE", " TRUE "],
    ["OPENCLAW_NIX_MODE", "1"],
  ])("does not acquire a runtime when %s=%s", async (key, value) => {
    const f = automaticFixture();
    vi.stubEnv(key, value);
    const update = vi.spyOn(cliUpdates, "updateCodexManagedCli").mockResolvedValue({
      status: "current",
      version: "99.1.0",
    });
    try {
      await f.service.start(f.ctx);
      await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
      expect(update).not.toHaveBeenCalled();
      expect(binaries.resolveManagedCodexAppServerStartOptions).not.toHaveBeenCalled();
    } finally {
      await f.service.stop?.(f.ctx);
    }
  });

  it("joins an in-flight automatic update on shutdown and revokes publication", async () => {
    const f = automaticFixture();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const published = vi.fn();
    vi.spyOn(cliUpdates, "updateCodexManagedCli").mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      params.assertCurrent();
      published();
      return { status: "updated", version: "99.1.0" };
    });
    await f.service.start(f.ctx);
    const clock = vi.advanceTimersByTimeAsync(60_000);
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await entered.promise;
      stopping = Promise.resolve(f.service.stop?.(f.ctx)).then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(f.service.getScheduler()).toBeUndefined();
    } finally {
      release.resolve();
      await clock;
      await stopping;
      await f.service.stop?.(f.ctx);
    }
    expect(stopped).toBe(true);
    expect(published).not.toHaveBeenCalled();
    expect(f.ctx.logger.info).not.toHaveBeenCalled();
  });

  it("qualifies once, then verifies the selected runtime without another process", async () => {
    const f = fixture();
    const findings = await f.check.detect(f.ctx);
    expect(findings).toHaveLength(1);
    const result = await f.check.repair!({ ...f.ctx, mode: "fix" }, findings);
    expect(result.status).toBe("repaired");
    expect(result.changes[0]).toContain("Existing sessions retain their original generation");
    expect(f.deps.probe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        appBundlePath: "/staged/ChatGPT.app",
        agents: [expect.objectContaining({ models: ["gpt-5.6-sol"], requiresComputerUse: true })],
      }),
    );
    await expect(f.check.detect(f.ctx, { findings })).resolves.toEqual([]);
    expect(f.deps.probe).toHaveBeenCalledOnce();
    expect(f.deps.resolveCommand).toHaveBeenCalledTimes(3);
  });

  it("qualifies alternate and aliased fallback Codex routes even with a non-Codex primary", async () => {
    const f = fixture();
    f.cfg.agents!.defaults = {
      model: { primary: "anthropic/claude", fallbacks: ["backup"] },
      models: {
        "openai/gpt-5.6-sol": { alias: "backup", agentRuntime: { id: "codex" } },
        "openai/other-codex-model": { agentRuntime: { id: "codex" } },
      },
    };
    f.cfg.agents!.entries!.other = {
      agentDir: path.join(f.root, "other"),
      model: "anthropic/claude",
      models: { "openai/private-model": { agentRuntime: { id: "codex" } } },
    };
    const findings = await f.check.detect(f.ctx);
    expect(findings).toHaveLength(1);
    const result = await f.check.repair!({ ...f.ctx, mode: "fix" }, findings);
    expect(result.status).toBe("repaired");
    expect(f.deps.probe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agents: [
          expect.objectContaining({
            models: ["gpt-5.6-sol", "other-codex-model"],
            codexHome: path.join(f.root, "agent/codex-home"),
          }),
          expect.objectContaining({
            models: ["gpt-5.6-sol", "other-codex-model", "private-model"],
            codexHome: path.join(f.root, "other/codex-home"),
          }),
        ],
      }),
    );
  });

  it("includes native-only Computer Use instead of trusting just OpenClaw's flag", async () => {
    const f = fixture();
    f.cfg.plugins!.entries!.codex!.config = {};
    const home = path.join(f.root, "agent", "codex-home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.toml"),
      '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
    );
    const findings = await f.check.detect(f.ctx);
    await f.check.repair!({ ...f.ctx, mode: "fix" }, findings);
    expect(f.deps.probe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agents: [expect.objectContaining({ requiresComputerUse: true, codexHome: home })],
      }),
    );
  });

  it("preserves cleanup uncertainty instead of converting it to a repair warning", async () => {
    const f = fixture();
    const error = new commandProcessCleanup.Error();
    f.deps.updateApp.mockRejectedValue(error);
    const findings = await f.check.detect(f.ctx);
    await expect(f.check.repair!({ ...f.ctx, mode: "fix" }, findings)).rejects.toBe(error);
  });

  it.each([
    { appServer: { command: "/custom/codex" } },
    {
      appServer: {
        transport: "websocket",
        url: "wss://remote.invalid",
        authToken: "test-only-remote-auth",
      },
    },
  ])("leaves explicitly owned runtime configurations alone: %j", async (config) => {
    const f = fixture();
    f.cfg.plugins!.entries!.codex!.config = config;
    await expect(f.check.detect(f.ctx)).resolves.toEqual([]);
    expect(f.deps.resolveCommand).not.toHaveBeenCalled();
    expect(f.deps.updateApp).not.toHaveBeenCalled();
  });

  it("updates package-only CLI with candidate qualification and revalidates the selected command", async () => {
    const f = fixture();
    f.deps.resolveCommand.mockImplementation(async (start) => ({
      ...start,
      command: "/plugin/node_modules/codex",
      commandSource: "resolved-managed",
    }));
    const updateCli = vi.fn(
      async (
        params: Parameters<
          typeof import("./app-server/managed-cli-update.js").updateCodexManagedCli
        >[0],
      ) => {
        await params.validateCandidate("/managed/cli/bin/codex.js", "99.0.0");
        return {
          status: "updated" as const,
          version: "99.0.0",
          command: "/managed/cli/bin/codex.js",
        };
      },
    );
    const check = createCodexRuntimeMaintenanceChecks(f.operation, {
      ...f.deps,
      updateCli,
    })[0]!;
    const findings = await check.detect(f.ctx);
    expect(findings).toHaveLength(1);
    const result = await check.repair!({ ...f.ctx, mode: "fix" }, findings);
    expect(result).toMatchObject({
      status: "repaired",
      changes: [expect.stringContaining("99.0.0")],
    });
    expect(f.deps.probe).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/managed/cli/bin/codex.js" }),
    );
    expect(f.deps.updateApp).not.toHaveBeenCalled();
    // A publisher returning success cannot certify a resolver still on the old selection.
    await expect(check.detect(f.ctx, { findings })).resolves.toHaveLength(1);
    f.deps.resolveCommand.mockImplementation(async (start) => ({
      ...start,
      command: "/managed/cli/bin/codex.js",
      commandSource: "resolved-managed",
    }));
    await expect(check.detect(f.ctx, { findings })).resolves.toEqual([]);
    expect(f.deps.probe).toHaveBeenCalledOnce();
  });

  it("does not download during dry-run or after authority is revoked", async () => {
    const f = fixture();
    const findings = await f.check.detect(f.ctx);
    await expect(
      f.check.repair!({ ...f.ctx, mode: "fix", dryRun: true }, findings),
    ).resolves.toMatchObject({ status: "skipped" });
    f.controller.abort(new Error("lease ended"));
    await expect(f.check.repair!({ ...f.ctx, mode: "fix" }, findings)).rejects.toThrow(
      "lease ended",
    );
    expect(f.deps.updateApp).not.toHaveBeenCalled();
  });

  it("reports cleanup warnings without falsely claiming the old application was kept", async () => {
    const f = fixture();
    f.deps.updateApp.mockResolvedValue({
      status: "updated",
      oldVersion: "1",
      newVersion: "2",
      appBundlePath: "/Applications/ChatGPT.app",
      backupPath: "/rollback/ChatGPT.app",
      warnings: ["Detach failed; staging retained"],
    });
    const result = await f.check.repair!({ ...f.ctx, mode: "fix" }, await f.check.detect(f.ctx));
    expect(result.status).toBe("failed");
    expect(result.changes[0]).toContain("Selected verified Codex desktop");
    expect(result.warnings).toEqual(["Detach failed; staging retained"]);
  });

  it("keeps compatibility failure actionable rather than claiming a successful update", async () => {
    const f = fixture();
    f.deps.probe.mockRejectedValue(new Error("candidate lacks required MCP tools"));
    const findings = await f.check.detect(f.ctx);
    const result = await f.check.repair!({ ...f.ctx, mode: "fix" }, findings);
    expect(result.status).toBe("failed");
    expect(result.changes).toEqual([]);
    expect(result.warnings?.[0]).toContain("candidate lacks required MCP tools");
  });
});
