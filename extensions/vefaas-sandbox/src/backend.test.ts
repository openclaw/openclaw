import { afterEach, describe, expect, it, vi } from "vitest";
import { createVefaasSandboxBackendManager } from "./backend.js";
import { resolveVefaasPluginConfig } from "./config.js";
import { setVefaasProvisionerCommandRunnerForTest } from "./provisioner.js";

describe("vefaas backend manager", () => {
  afterEach(() => {
    setVefaasProvisionerCommandRunnerForTest();
  });

  it("checks runtime status with config override from OpenClaw config", async () => {
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "{}",
      stderr: "",
    });
    setVefaasProvisionerCommandRunnerForTest(runner);

    const manager = createVefaasSandboxBackendManager({
      pluginConfig: resolveVefaasPluginConfig({
        command: "vefaas",
        image: "default-image",
      }),
    });

    const result = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-vefaas-session",
        backendId: "vefaas",
        runtimeLabel: "openclaw-vefaas-session",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "custom-image",
        configLabelKind: "Image",
      },
      config: {
        plugins: {
          entries: {
            "vefaas-sandbox": {
              enabled: true,
              config: {
                command: "vefaas",
                image: "custom-image",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-image",
      configLabelMatch: true,
    });
    expect(runner).toHaveBeenCalledWith({
      argv: ["vefaas", "get", "--name", "openclaw-vefaas-session"],
      cwd: undefined,
      timeoutMs: 120_000,
      env: process.env,
    });
  });

  it("removes runtimes through the provisioner", async () => {
    const runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    setVefaasProvisionerCommandRunnerForTest(runner);

    const manager = createVefaasSandboxBackendManager({
      pluginConfig: resolveVefaasPluginConfig({
        command: "/usr/local/bin/vefaas",
      }),
    });

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-vefaas-session",
        backendId: "vefaas",
        runtimeLabel: "openclaw-vefaas-session",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image:
          "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
        configLabelKind: "Image",
      },
      config: {},
    });

    expect(runner).toHaveBeenCalledWith({
      argv: ["/usr/local/bin/vefaas", "delete", "--name", "openclaw-vefaas-session"],
      cwd: undefined,
      timeoutMs: 120_000,
      env: process.env,
    });
  });
});
