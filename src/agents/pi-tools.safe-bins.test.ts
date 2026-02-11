import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";

const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

beforeAll(() => {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(
    os.tmpdir(),
    "openclaw-test-no-bundled-extensions",
  );
});

afterAll(() => {
  if (previousBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
  }
});

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => "/usr/bin:/bin"),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 500),
  };
});

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
  resolvePluginTools: () => [],
}));

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return { ...mod, getShellPathFromLoginShell: () => null };
});

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
  getPluginToolMeta: () => undefined,
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

describe("createOpenClawCodingTools safeBins", () => {
  it("threads tools.exec.safeBins into exec allowlist checks", async () => {
    if (process.platform === "win32") {
      return;
    }

    const { createOpenClawCodingTools } = await import("./pi-tools.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-safe-bins-"));
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "off",
          safeBins: ["echo"],
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, "agent"),
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const marker = `safe-bins-${Date.now()}`;
    const prevShellEnvTimeoutMs = process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS;
    process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS = "1000";
    const result = await (async () => {
      try {
        return await execTool!.execute("call1", {
          command: `echo ${marker}`,
          workdir: tmpDir,
        });
      } finally {
        if (prevShellEnvTimeoutMs === undefined) {
          delete process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS;
        } else {
          process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS = prevShellEnvTimeoutMs;
        }
      }
    })();
    const text = result.content.find((content) => content.type === "text")?.text ?? "";

    expect(result.details.status).toBe("completed");
    expect(text).toContain(marker);
  });
});
