import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";

const bundledPluginsDirSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR"]);

beforeAll(() => {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(
    os.tmpdir(),
    "openclaw-test-no-bundled-extensions",
  );
});

afterAll(() => {
  bundledPluginsDirSnapshot.restore();
});

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 500),
  };
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
    const envSnapshot = captureEnv(["OPENCLAW_SHELL_ENV_TIMEOUT_MS"]);
    const result = await (async () => {
      try {
        process.env.OPENCLAW_SHELL_ENV_TIMEOUT_MS = "1000";
        return await execTool!.execute("call1", {
          command: `echo ${marker}`,
          workdir: tmpDir,
        });
      } finally {
        envSnapshot.restore();
      }
    })();
    const text = result.content.find((content) => content.type === "text")?.text ?? "";

    expect(result.details.status).toBe("completed");
    expect(text).toContain(marker);
  });

  it("does not allow env var expansion to smuggle file args via safeBins", async () => {
    if (process.platform === "win32") {
      return;
    }

    const { createOpenClawCodingTools } = await import("./pi-tools.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-safe-bins-expand-"));

    const secret = `TOP_SECRET_${Date.now()}`;
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), `${secret}\n`, "utf8");

    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          ask: "off",
          safeBins: ["head", "wc"],
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

    const result = await execTool!.execute("call1", {
      command: "head $FOO ; wc -l",
      workdir: tmpDir,
      env: { FOO: "secret.txt" },
    });
    const text = result.content.find((content) => content.type === "text")?.text ?? "";

    expect(result.details.status).toBe("completed");
    expect(text).not.toContain(secret);
  });
});
