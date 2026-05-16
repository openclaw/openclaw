import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVefaasPluginConfig } from "./config.js";
import {
  buildVefaasProvisionerArgv,
  runVefaasProvisioner,
  setVefaasProvisionerCommandRunnerForTest,
} from "./provisioner.js";

describe("vefaas provisioner", () => {
  afterEach(() => {
    setVefaasProvisionerCommandRunnerForTest();
  });

  it("builds provisioner argv with a JSON create spec", () => {
    const config = resolveVefaasPluginConfig({
      command: "/usr/local/bin/vefaas",
      region: "cn-beijing",
    });

    const argv = buildVefaasProvisionerArgv({
      context: {
        config,
        sandboxName: "openclaw-vefaas-session",
      },
      action: "create",
      spec: {
        backend: "vefaas",
        mode: "remote",
        functionId: undefined,
        region: "cn-beijing",
        endpoint: undefined,
        image:
          "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
        remoteWorkspaceDir: "/workspace",
        remoteAgentWorkspaceDir: "/agent",
        ttlSeconds: 3600,
        resources: undefined,
        network: undefined,
      },
    });

    expect(argv.slice(0, 4)).toEqual([
      "/usr/local/bin/vefaas",
      "create",
      "--name",
      "openclaw-vefaas-session",
    ]);
    expect(argv[4]).toBe("--spec-json");
    expect(JSON.parse(argv[5] ?? "{}")).toMatchObject({
      backend: "vefaas",
      region: "cn-beijing",
      image:
        "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
    });
  });

  it("runs the provisioner with configured timeout and cwd", async () => {
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "{}",
      stderr: "",
    });
    setVefaasProvisionerCommandRunnerForTest(runner);

    const config = resolveVefaasPluginConfig({
      command: "vefaas",
      timeoutSeconds: 12,
    });
    await runVefaasProvisioner({
      context: {
        config,
        sandboxName: "openclaw-vefaas-session",
      },
      action: "get",
      cwd: "/repo",
    });

    expect(runner).toHaveBeenCalledWith({
      argv: ["vefaas", "get", "--name", "openclaw-vefaas-session"],
      cwd: "/repo",
      timeoutMs: 12_000,
      env: process.env,
    });
  });

  it("builds OpenCode start argv with a JSON attempt payload", () => {
    const config = resolveVefaasPluginConfig({
      command: "vefaas",
    });

    const argv = buildVefaasProvisionerArgv({
      context: {
        config,
        sandboxName: "openclaw-vefaas-session",
      },
      action: "opencode-start",
      attempt: {
        attemptId: "attempt-123",
        prompt: "implement the task",
        sessionId: "session-1",
        workspaceDir: "/workspace",
        metadata: {
          source: "openclaw",
        },
      },
    });

    expect(argv.slice(0, 4)).toEqual([
      "vefaas",
      "opencode-start",
      "--name",
      "openclaw-vefaas-session",
    ]);
    expect(argv[4]).toBe("--attempt-json");
    expect(JSON.parse(argv[5] ?? "{}")).toMatchObject({
      attemptId: "attempt-123",
      prompt: "implement the task",
      sessionId: "session-1",
    });
  });

  it("builds OpenCode attempt lifecycle argv with an attempt id", () => {
    const config = resolveVefaasPluginConfig({
      command: "vefaas",
    });

    for (const action of ["opencode-events", "opencode-stop", "snapshot"] as const) {
      expect(
        buildVefaasProvisionerArgv({
          context: {
            config,
            sandboxName: "openclaw-vefaas-session",
          },
          action,
          attemptId: "attempt-123",
        }),
      ).toEqual([
        "vefaas",
        action,
        "--name",
        "openclaw-vefaas-session",
        "--attempt-id",
        "attempt-123",
      ]);
    }
  });
});
