import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bash-tools.exec.workspace-env.js", () => ({
  loadWorkspaceDotEnvForExec: vi.fn(async () => ({ WORKSPACE_ONLY: "workspace-marker" })),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async (params: unknown) => ({
    content: [{ type: "text", text: "mock-node-ok" }],
    details: {
      status: "completed",
      exitCode: 0,
      durationMs: 1,
      aggregated: "mock-node-ok",
      cwd: (params as { workdir?: string }).workdir ?? process.cwd(),
      envSnapshot: (params as { env?: Record<string, string> }).env,
    },
  })),
}));

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let loadWorkspaceDotEnvForExec: typeof import("./bash-tools.exec.workspace-env.js").loadWorkspaceDotEnvForExec;
let executeNodeHostCommand: typeof import("./bash-tools.exec-host-node.js").executeNodeHostCommand;

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ loadWorkspaceDotEnvForExec } = await import("./bash-tools.exec.workspace-env.js"));
  ({ executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.WORKSPACE_ONLY;
});

describe("workspace .env loading by exec host", () => {
  it("loads workspace .env for gateway host", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call-gateway", {
      command:
        process.platform === "win32"
          ? "Write-Output $env:WORKSPACE_ONLY"
          : "echo ${WORKSPACE_ONLY:-}",
    });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("workspace-marker");
    expect(loadWorkspaceDotEnvForExec).toHaveBeenCalledTimes(1);
  });

  it("skips workspace .env loading for node host", async () => {
    const tool = createExecTool({ host: "node", security: "full", ask: "off" });
    const result = await tool.execute("call-node", { command: "echo ok" });

    expect(loadWorkspaceDotEnvForExec).not.toHaveBeenCalled();
    expect(executeNodeHostCommand).toHaveBeenCalledTimes(1);

    const call = vi.mocked(executeNodeHostCommand).mock.calls[0]?.[0] as {
      env?: Record<string, string>;
      requestedEnv?: Record<string, string>;
    };
    expect(call.requestedEnv).toBeUndefined();
    expect(call.env?.WORKSPACE_ONLY).toBeUndefined();

    const details = result.details as { status?: string };
    expect(details.status).toBe("completed");
  });
});
