import fs from "node:fs/promises";
import path from "node:path";
import type { HealthCheckContext, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { commandProcessCleanup } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config.js";
import type { updateCodexDesktopApp } from "./app-server/desktop-app-update.js";
import type { probeCodexDesktopRuntime } from "./app-server/desktop-runtime-probe.js";
import { createCodexRuntimeMaintenanceChecks } from "./runtime-maintenance.js";

describe("selected Codex runtime maintenance", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function fixture() {
    const root = tempDirs.make("codex-maintenance-");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
        },
        list: [{ id: "main", agentDir: path.join(root, "agent") }],
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

  it("validates the staged runtime, then resolves and probes the actually selected runtime", async () => {
    const f = fixture();
    const findings = await f.check.detect(f.ctx);
    expect(findings).toHaveLength(1);
    const result = await f.check.repair!({ ...f.ctx, mode: "fix" }, findings);
    expect(result.status).toBe("repaired");
    expect(result.changes[0]).toContain("Previous runtime retained: /rollback/ChatGPT.app");
    expect(f.deps.probe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        appBundlePath: "/staged/ChatGPT.app",
        agents: [expect.objectContaining({ model: "gpt-5.6-sol", requiresComputerUse: true })],
      }),
    );
    await expect(f.check.detect(f.ctx, { findings })).resolves.toEqual([]);
    expect(f.deps.probe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        appBundlePath: "/Applications/ChatGPT.app",
      }),
    );
    expect(f.deps.resolveCommand).toHaveBeenCalledTimes(3);
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

  it("leaves package selection with the existing package owner", async () => {
    const f = fixture();
    f.deps.resolveCommand.mockImplementation(async (start) => ({
      ...start,
      command: "/plugin/node_modules/codex",
      commandSource: "resolved-managed",
    }));
    await expect(f.check.detect(f.ctx)).resolves.toEqual([]);
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
