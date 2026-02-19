import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";

vi.mock("./exec-remote.js", () => ({
  runRemoteExec: vi.fn(),
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

describe("exec remote hosts", () => {
  it("routes host=remote-ssh to runRemoteExec", async () => {
    const { runRemoteExec } = await import("./exec-remote.js");
    const runRemoteExecMock = vi.mocked(runRemoteExec);
    runRemoteExecMock.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      stdout: "remote-ok",
      stderr: "",
      timedOut: false,
      durationMs: 7,
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "remote-ssh",
      security: "full",
      ask: "off",
      remote: {
        ssh: {
          target: "user@gateway-host",
        },
      },
    });

    const result = await tool.execute("call", { command: "pwd" });
    expect(result.details.status).toBe("completed");
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    expect(text).toContain("remote-ok");
    expect(runRemoteExecMock).toHaveBeenCalledTimes(1);
    expect(runRemoteExecMock.mock.calls[0]?.[0]).toMatchObject({
      target: {
        host: "remote-ssh",
        sshTarget: "user@gateway-host",
      },
      command: "pwd",
    });
  });

  it("uses remote-container defaults from tools.exec.remote", async () => {
    const { runRemoteExec } = await import("./exec-remote.js");
    const runRemoteExecMock = vi.mocked(runRemoteExec);
    runRemoteExecMock.mockClear();
    runRemoteExecMock.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      stdout: "container-ok",
      stderr: "",
      timedOut: false,
      durationMs: 5,
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "remote-container",
      security: "full",
      ask: "off",
      remote: {
        container: {
          context: "prod-ssh",
          name: "worker",
        },
      },
    });

    const result = await tool.execute("call", { command: "ls -la" });
    expect(result.details.status).toBe("completed");
    expect(runRemoteExecMock.mock.calls.at(-1)?.[0]).toMatchObject({
      target: {
        host: "remote-container",
        containerContext: "prod-ssh",
        containerName: "worker",
      },
    });
  });

  it("rejects remote-k8s-pod when namespace/pod are missing", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "remote-k8s-pod",
      security: "full",
      ask: "off",
    });

    await expect(
      tool.execute("call", {
        command: "pwd",
      }),
    ).rejects.toThrow(/remote-k8s-pod requires k8sNamespace and k8sPod/);
  });
});
