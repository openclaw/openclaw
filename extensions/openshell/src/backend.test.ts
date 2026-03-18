import { describe, expect, it, vi, beforeEach } from "vitest";

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
}));

vi.mock("./cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli.js")>();
  return {
    ...actual,
    runOpenShellCli: cliMocks.runOpenShellCli,
  };
});

import { createOpenShellSandboxBackendManager } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

describe("openshell backend manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks runtime status with config override from OpenClaw config", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "{}",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "openshell",
        from: "openclaw",
      }),
    });

    const result = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-session-1234",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-1234",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "custom-source",
        configLabelKind: "Source",
      },
      config: {
        plugins: {
          entries: {
            openshell: {
              enabled: true,
              config: {
                command: "openshell",
                from: "custom-source",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-source",
      configLabelMatch: true,
    });
    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-1234",
        config: expect.objectContaining({
          from: "custom-source",
        }),
      }),
      args: ["sandbox", "get", "openclaw-session-1234"],
    });
  });

  it("removes runtimes via openshell sandbox delete", async () => {
    cliMocks.runOpenShellCli.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const manager = createOpenShellSandboxBackendManager({
      pluginConfig: resolveOpenShellPluginConfig({
        command: "/usr/local/bin/openshell",
        gateway: "lab",
      }),
    });

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-session-5678",
        backendId: "openshell",
        runtimeLabel: "openclaw-session-5678",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw",
        configLabelKind: "Source",
      },
      config: {},
    });

    expect(cliMocks.runOpenShellCli).toHaveBeenCalledWith({
      context: expect.objectContaining({
        sandboxName: "openclaw-session-5678",
        config: expect.objectContaining({
          command: "/usr/local/bin/openshell",
          gateway: "lab",
        }),
      }),
      args: ["sandbox", "delete", "openclaw-session-5678"],
    });
  });
});
